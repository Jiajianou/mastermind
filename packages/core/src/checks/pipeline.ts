import { existsSync } from "node:fs";
import { ActionError, assertTransition } from "../actions/index.js";
import type { ClaudeCli } from "../claude.js";
import { systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import type { ResolvedConfig } from "../config/index.js";
import { isEditingRole } from "../contracts/index.js";
import type { Check, CheckKind, Task, TaskStatus } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { Environment } from "../env.js";
import type { EventBus } from "../events.js";
import type { Git } from "../git/index.js";
import type { ProcessRegistry } from "../procs.js";
import type { UsageBackoff } from "../sessions/effects.js";
import type { SessionManager } from "../sessions/manager.js";
import { createOneShotRunner } from "../sessions/one-shot.js";
import { createSessionSpawner } from "../sessions/spawner.js";
import { createFlakyJudge } from "./judge.js";
import { readLogTail } from "./log.js";
import { decideAfterFailure, statusAfterPassing } from "./outcome.js";
import { checkFailurePrompt, checkName, conflictPrompt, findingsPrompt } from "./prompts.js";
import type { FailedCheck } from "./prompts.js";
import { abortRebase, rebaseOntoMain } from "./rebase.js";
import { createReviewer } from "./reviewer.js";
import { errorMessage, runShellCheck } from "./runner.js";
import type { CheckContext } from "./runner.js";

export interface CheckPipelineOptions {
  db: Db;
  bus: EventBus;
  git: Git;
  cli: ClaudeCli;
  registry: ProcessRegistry;
  env: Environment;
  repoRoot: string;
  promptsDir: string;
  logsDir: string;
  config: () => ResolvedConfig;
  fixers: Pick<SessionManager, "startFixer">;
  backoff: UsageBackoff;
  onError: (error: unknown) => void;
  clock?: Clock;
}

export interface CheckPipeline {
  start(): void;
  stop(): void;
  rerun(taskId: string): Task;
}

type Outcome =
  | { kind: "passed"; changedFiles: string[] }
  | { kind: "fix"; prompt: string; reason: string; countsAttempt: boolean; conflict: boolean }
  | { kind: "parked" }
  | { kind: "superseded" }
  | { kind: "block"; reason: string };

interface Turn {
  taskId: string;
  superseded: boolean;
}

interface Run {
  turn: Turn;
  task: Task;
  worktree: string;
  config: ResolvedConfig;
  followsConflictFixer: boolean;
  rerunUsed: boolean;
}

const parked: Outcome = { kind: "parked" };
const superseded: Outcome = { kind: "superseded" };
const tailLimits = { maxBytes: 64 * 1024, maxLines: 80 };

// A function rather than a property read, so the flag isn't narrowed across the awaits that may change it.
const wasSuperseded = (turn: Turn): boolean => turn.superseded;

export function createCheckPipeline(options: CheckPipelineOptions): CheckPipeline {
  const { db, bus, git, onError, clock = systemClock } = options;
  const context: CheckContext & { git: Git } = {
    db,
    bus,
    git,
    registry: options.registry,
    env: options.env,
    clock,
    logsDir: options.logsDir,
    onError,
  };
  const oneShot = createOneShotRunner({
    db,
    bus,
    backoff: options.backoff,
    spawner: createSessionSpawner({ db, bus, cli: options.cli, logsDir: options.logsDir, onError }),
  });
  const judge = createFlakyJudge({ oneShot, config: options.config });
  const reviewer = createReviewer({
    ...context,
    oneShot,
    promptsDir: options.promptsDir,
    config: options.config,
  });

  const queue: string[] = [];
  const waiting = new Set<string>();
  const conflictFixers = new Map<string, number>();
  const statuses = new Map<string, TaskStatus>();
  let active: Turn | null = null;
  let draining = false;
  let unsubscribe: (() => void) | null = null;

  function emitTask(task: Task): void {
    bus.emit({ type: "task.updated", taskId: task.id, task });
  }

  // Claude calls (judge, reviewer, fixer) wait while work is paused, signed out or backing off; the task stays in
  // checking and its pipeline runs again once work resumes.
  function claudeAllowed(): boolean {
    const { paused, authRequired, backoffResumeAt } = db.flags.get();
    const backingOff =
      backoffResumeAt !== null && Date.parse(backoffResumeAt) > clock.now().getTime();
    return !paused && !authRequired && !backingOff;
  }

  async function failedCheck(check: Check): Promise<FailedCheck> {
    if (check.logPath === null || !existsSync(check.logPath)) return { check, logTail: "" };
    return { check, logTail: (await readLogTail(check.logPath, tailLimits)).text };
  }

  const failureReason = (check: Check): string =>
    `the ${checkName(check)} check failed: ${check.summary ?? "no details"}`;

  async function runCommand(run: Run, kind: CheckKind, command: string): Promise<Outcome | null> {
    if (wasSuperseded(run.turn)) return superseded;
    const target = { taskId: run.task.id, round: run.task.round, kind, cwd: run.worktree, command };
    let check = await runShellCheck(context, target);
    if (check.status === "passed") return null;
    if (wasSuperseded(run.turn)) return superseded;
    if (!claudeAllowed()) return parked;
    let failed = await failedCheck(check);
    if (!run.rerunUsed) {
      const verdict = await judge.judge(run.task, run.worktree, failed);
      if (!claudeAllowed()) return parked;
      if (verdict?.flaky === true) {
        run.rerunUsed = true;
        const notes = [`Re-run because the failure looked flaky: ${verdict.reason}`];
        check = await runShellCheck(context, { ...target, notes });
        if (check.status === "passed") return null;
        failed = await failedCheck(check);
      }
    }
    return {
      kind: "fix",
      prompt: checkFailurePrompt(run.task, failed),
      reason: failureReason(check),
      countsAttempt: true,
      conflict: false,
    };
  }

  async function changedFiles(worktree: string, upstream: string): Promise<string[]> {
    const output = await git.run(worktree, ["diff", "--name-only", upstream, "HEAD"]);
    return output.split("\n").filter((line) => line !== "");
  }

  async function checkTask(run: Run): Promise<Outcome> {
    const { config, worktree } = run;
    const { build, test } = config.commands;
    if (build.trim() !== "") {
      const failed = await runCommand(run, "build", build.trim());
      if (failed !== null) return failed;
    }
    const acceptance = await runCommand(run, "acceptance", run.task.acceptance);
    if (acceptance !== null) return acceptance;

    if (wasSuperseded(run.turn)) return superseded;
    const rebase = await rebaseOntoMain(context, {
      taskId: run.task.id,
      round: run.task.round,
      worktree,
      repoRoot: options.repoRoot,
      mainBranch: config.mainBranch,
    });
    if (rebase.kind === "conflict") {
      const { logTail } = await failedCheck(rebase.check);
      const gaveUp = run.followsConflictFixer;
      return {
        kind: "fix",
        prompt: conflictPrompt(run.task, {
          upstream: rebase.upstream,
          mainBranch: config.mainBranch,
          logTail,
        }),
        reason: gaveUp
          ? `the fixer could not resolve the rebase conflict: ${rebase.check.summary ?? ""}`
          : (rebase.check.summary ?? "rebase conflict"),
        countsAttempt: gaveUp,
        conflict: true,
      };
    }
    if (run.task.baseCommit !== rebase.upstream) {
      run.task = db.tasks.update(run.task.id, { baseCommit: rebase.upstream });
      emitTask(run.task);
    }

    if (test.trim() !== "") {
      const failed = await runCommand(run, "suite", test.trim());
      if (failed !== null) return failed;
    }

    if (config.reviewer.enabled) {
      if (wasSuperseded(run.turn)) return superseded;
      if (!claudeAllowed()) return parked;
      const review = await reviewer.review({
        task: run.task,
        worktree,
        upstream: rebase.upstream,
        mainBranch: config.mainBranch,
      });
      if (review.kind === "unanswered" && !claudeAllowed()) return parked;
      const serious =
        review.kind === "reviewed"
          ? review.findings.filter((finding) => finding.severity === "serious")
          : [];
      if (serious.length > 0)
        return {
          kind: "fix",
          prompt: findingsPrompt(run.task, serious),
          reason: `the reviewer reported ${String(serious.length)} serious finding${serious.length === 1 ? "" : "s"}`,
          countsAttempt: true,
          conflict: false,
        };
    }
    return { kind: "passed", changedFiles: await changedFiles(worktree, rebase.upstream) };
  }

  function stillChecking(taskId: string): Task | null {
    const task = db.tasks.get(taskId);
    return task?.status === "checking" ? task : null;
  }

  function block(taskId: string, attempts: number, reason: string): void {
    const blocked = db.transaction(() => {
      const task = stillChecking(taskId);
      if (task === null) return null;
      assertTransition(taskId, task.status, "blocked");
      const session = db.sessions.listForTask(taskId).findLast(isEditingRole);
      const tries = `${String(attempts)} attempt${attempts === 1 ? "" : "s"}`;
      const event =
        session === undefined
          ? null
          : db.events.append({
              sessionId: session.id,
              type: "error",
              summary: `Blocked after ${tries}: ${reason}`,
              payload: JSON.stringify({ type: "blocked", attempts, reason }),
            });
      return { event, task: db.tasks.update(taskId, { status: "blocked", attempts }) };
    });
    if (blocked === null) return;
    if (blocked.event !== null)
      bus.emit({
        type: "session.event",
        sessionId: blocked.event.sessionId,
        taskId,
        event: blocked.event,
      });
    emitTask(blocked.task);
  }

  async function startFixer(taskId: string, outcome: Extract<Outcome, { kind: "fix" }>) {
    const task = stillChecking(taskId);
    if (task === null) return;
    const decision = decideAfterFailure({
      attempts: task.attempts,
      maxAttempts: options.config().maxAttempts,
      countsAttempt: outcome.countsAttempt,
    });
    if (decision.kind === "block") {
      block(taskId, decision.attempts, outcome.reason);
      return;
    }
    if (!claudeAllowed()) {
      waiting.add(taskId);
      return;
    }
    try {
      const fixer = await options.fixers.startFixer({
        taskId,
        prompt: outcome.prompt,
        attempts: decision.attempts,
      });
      if (outcome.conflict) conflictFixers.set(taskId, fixer.id);
    } catch (error) {
      onError(error);
      waiting.add(taskId);
    }
  }

  function pass(taskId: string, changed: readonly string[]): void {
    const passed = db.transaction(() => {
      const task = stillChecking(taskId);
      if (task === null) return null;
      const next = statusAfterPassing(task, changed, options.config());
      assertTransition(taskId, task.status, next);
      return db.tasks.update(taskId, { status: next });
    });
    if (passed !== null) emitTask(passed);
  }

  async function settle(taskId: string, outcome: Outcome): Promise<void> {
    switch (outcome.kind) {
      case "passed":
        pass(taskId, outcome.changedFiles);
        return;
      case "fix":
        await startFixer(taskId, outcome);
        return;
      case "parked":
        waiting.add(taskId);
        return;
      case "superseded":
        return;
      case "block":
        block(taskId, db.tasks.get(taskId)?.attempts ?? 0, outcome.reason);
        return;
    }
  }

  function followsConflictFixer(taskId: string): boolean {
    const fixerId = conflictFixers.get(taskId);
    conflictFixers.delete(taskId);
    return (
      fixerId !== undefined &&
      db.sessions.listForTask(taskId).findLast(isEditingRole)?.id === fixerId
    );
  }

  async function checkWorkspace(turn: Turn, task: Task): Promise<Outcome> {
    const { worktree } = task;
    if (worktree === null || !existsSync(worktree))
      return { kind: "block", reason: "its workspace is gone" };
    const run: Run = {
      turn,
      task,
      worktree,
      config: options.config(),
      followsConflictFixer: followsConflictFixer(task.id),
      rerunUsed: false,
    };
    // A fixer that gave up, or a run killed mid-rebase, can leave a rebase in progress; the checks need the branch.
    await abortRebase(git, worktree);
    return checkTask(run);
  }

  async function runPipeline(turn: Turn): Promise<void> {
    const task = stillChecking(turn.taskId);
    if (task === null) return;
    let outcome: Outcome;
    try {
      outcome = await checkWorkspace(turn, task);
    } catch (error) {
      onError(error);
      outcome = { kind: "block", reason: `its checks could not run: ${errorMessage(error)}` };
    }
    await settle(turn.taskId, wasSuperseded(turn) ? superseded : outcome);
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (let taskId = queue.shift(); taskId !== undefined; taskId = queue.shift()) {
        active = { taskId, superseded: false };
        try {
          await runPipeline(active);
        } catch (error) {
          onError(error);
        } finally {
          active = null;
        }
      }
    } finally {
      draining = false;
    }
  }

  const pending = (taskId: string): boolean =>
    queue.includes(taskId) || (active?.taskId === taskId && !active.superseded);

  function enqueue(taskId: string): void {
    if (unsubscribe === null || pending(taskId)) return;
    waiting.delete(taskId);
    queue.push(taskId);
    Promise.resolve().then(drain).catch(onError);
  }

  return {
    start() {
      if (unsubscribe !== null) return;
      for (const task of db.tasks.list()) statuses.set(task.id, task.status);
      unsubscribe = bus.subscribe((event) => {
        if (event.type === "task.updated") {
          const previous = statuses.get(event.taskId);
          statuses.set(event.taskId, event.task.status);
          // A task that leaves checking mid-run (a steered session resumed) makes the run's outcome stale; if it
          // comes back to checking, it is queued for a fresh run.
          if (active?.taskId === event.taskId && event.task.status !== "checking")
            active.superseded = true;
          if (event.task.status === "checking" && previous !== "checking") enqueue(event.taskId);
        }
        if (
          (event.type === "scheduler.updated" || event.type === "auth.updated") &&
          claudeAllowed()
        )
          for (const taskId of [...waiting]) enqueue(taskId);
      });
      for (const [taskId, status] of statuses) if (status === "checking") enqueue(taskId);
    },

    stop() {
      unsubscribe?.();
      unsubscribe = null;
      queue.length = 0;
      if (active !== null) active.superseded = true;
    },

    rerun(taskId) {
      const task = db.tasks.get(taskId);
      if (task === null) throw ActionError.fromMessage("not_found", `no task "${taskId}"`);
      if (task.status === "checking") {
        if (pending(taskId))
          throw ActionError.fromMessage("conflict", `the checks of ${taskId} are already running`);
        enqueue(taskId);
        return task;
      }
      if (task.status !== "review")
        throw ActionError.fromMessage(
          "conflict",
          `checks re-run only for a task in review or checking; ${taskId} is ${task.status}`,
        );
      const checking = db.tasks.update(taskId, { status: "checking" });
      emitTask(checking);
      return checking;
    },
  };
}
