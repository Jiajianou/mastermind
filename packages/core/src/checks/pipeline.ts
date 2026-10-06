import { existsSync } from "node:fs";
import { ActionError, assertTransition } from "../actions/index.js";
import type { ClaudeCli } from "../claude.js";
import { systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import type { ResolvedConfig } from "../config/index.js";
import type { CheckKind, Task, TaskStatus } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { Environment } from "../env.js";
import type { EventBus } from "../events.js";
import type { Git } from "../git/index.js";
import type { ProcessRegistry } from "../procs.js";
import type { UsageBackoff } from "../sessions/effects.js";
import { createOneShotRunner } from "../sessions/one-shot.js";
import { createSessionSpawner } from "../sessions/spawner.js";
import { checkFailureRequest, conflictRequest, readFailedCheck } from "./fixing.js";
import type { FixerLauncher, FixRequest } from "./fixing.js";
import { createFlakyJudge } from "./judge.js";
import { statusAfterPassing } from "./outcome.js";
import { findingsPrompt } from "./prompts.js";
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
  launcher: FixerLauncher;
  backoff: UsageBackoff;
  onError: (error: unknown) => void;
  clock?: Clock;
}

export interface CheckPipeline {
  start(): void;
  stop(): void;
  rerun(taskId: string): Task;
}

// "current" re-checks a branch after main moved: only the rebase, the full suite and the reviewer (PLAN 9.2).
type CheckScope = "full" | "current";

type Outcome =
  | { kind: "passed"; changedFiles: string[] }
  | ({ kind: "fix" } & FixRequest)
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
  scope: CheckScope;
  config: ResolvedConfig;
  followsConflictFixer: boolean;
  rerunUsed: boolean;
}

const parked: Outcome = { kind: "parked" };
const superseded: Outcome = { kind: "superseded" };

// A function rather than a property read, so the flag isn't narrowed across the awaits that may change it.
const wasSuperseded = (turn: Turn): boolean => turn.superseded;

export function createCheckPipeline(options: CheckPipelineOptions): CheckPipeline {
  const { db, bus, git, launcher, onError, clock = systemClock } = options;
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
  const claudeAllowed = (): boolean => launcher.claudeAllowed();
  const judge = createFlakyJudge({ oneShot, config: options.config });
  const reviewer = createReviewer({
    ...context,
    oneShot,
    promptsDir: options.promptsDir,
    config: options.config,
  });

  const queue: string[] = [];
  const waiting = new Set<string>();
  const scopes = new Map<string, CheckScope>();
  const statuses = new Map<string, TaskStatus>();
  let active: Turn | null = null;
  let draining = false;
  let unsubscribe: (() => void) | null = null;

  function emitTask(task: Task): void {
    bus.emit({ type: "task.updated", taskId: task.id, task });
  }

  async function runCommand(run: Run, kind: CheckKind, command: string): Promise<Outcome | null> {
    if (wasSuperseded(run.turn)) return superseded;
    const target = { taskId: run.task.id, round: run.task.round, kind, cwd: run.worktree, command };
    let check = await runShellCheck(context, target);
    if (check.status === "passed") return null;
    if (wasSuperseded(run.turn)) return superseded;
    if (!claudeAllowed()) return parked;
    let failed = await readFailedCheck(check);
    if (!run.rerunUsed) {
      const verdict = await judge.judge(run.task, run.worktree, failed);
      if (!claudeAllowed()) return parked;
      if (verdict?.flaky === true) {
        run.rerunUsed = true;
        const notes = [`Re-run because the failure looked flaky: ${verdict.reason}`];
        check = await runShellCheck(context, { ...target, notes });
        if (check.status === "passed") return null;
        failed = await readFailedCheck(check);
      }
    }
    return { kind: "fix", ...checkFailureRequest(run.task, failed) };
  }

  async function changedFiles(worktree: string, upstream: string): Promise<string[]> {
    const output = await git.run(worktree, ["diff", "--name-only", upstream, "HEAD"]);
    return output.split("\n").filter((line) => line !== "");
  }

  async function checkTask(run: Run): Promise<Outcome> {
    const { config, worktree } = run;
    const { build, test } = config.commands;
    if (run.scope === "full") {
      if (build.trim() !== "") {
        const failed = await runCommand(run, "build", build.trim());
        if (failed !== null) return failed;
      }
      const acceptance = await runCommand(run, "acceptance", run.task.acceptance);
      if (acceptance !== null) return acceptance;
    }

    if (wasSuperseded(run.turn)) return superseded;
    const rebase = await rebaseOntoMain(context, {
      taskId: run.task.id,
      round: run.task.round,
      worktree,
      repoRoot: options.repoRoot,
      mainBranch: config.mainBranch,
    });
    if (rebase.kind === "conflict")
      return {
        kind: "fix",
        ...(await conflictRequest(run.task, {
          check: rebase.check,
          upstream: rebase.upstream,
          mainBranch: config.mainBranch,
          fixerGaveUp: run.followsConflictFixer,
        })),
      };
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
        // Claude calls wait while work is paused, signed out or backing off; the task stays in checking and its
        // pipeline runs again once work resumes.
        if ((await launcher.fix(taskId, "checking", outcome)) === "waiting") waiting.add(taskId);
        return;
      case "parked":
        waiting.add(taskId);
        return;
      case "superseded":
        return;
      case "block":
        launcher.block(taskId, "checking", db.tasks.get(taskId)?.attempts ?? 0, outcome.reason);
        return;
    }
  }

  async function checkWorkspace(turn: Turn, task: Task, scope: CheckScope): Promise<Outcome> {
    const { worktree } = task;
    if (worktree === null || !existsSync(worktree))
      return { kind: "block", reason: "its workspace is gone" };
    const run: Run = {
      turn,
      task,
      worktree,
      scope,
      config: options.config(),
      followsConflictFixer: launcher.followsConflictFixer(task.id),
      rerunUsed: false,
    };
    // A fixer that gave up, or a run killed mid-rebase, can leave a rebase in progress; the checks need the branch.
    await abortRebase(git, worktree);
    return checkTask(run);
  }

  async function runPipeline(turn: Turn): Promise<void> {
    const task = stillChecking(turn.taskId);
    const scope = scopes.get(turn.taskId) ?? "full";
    scopes.delete(turn.taskId);
    if (task === null) return;
    let outcome: Outcome;
    try {
      outcome = await checkWorkspace(turn, task, scope);
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

  function moveToChecking(task: Task, scope: CheckScope): Task {
    assertTransition(task.id, task.status, "checking");
    scopes.set(task.id, scope);
    const checking = db.tasks.update(task.id, { status: "checking" });
    emitTask(checking);
    return checking;
  }

  async function mainCommit(): Promise<string> {
    const ref = `refs/heads/${options.config().mainBranch}`;
    return (await git.run(options.repoRoot, ["rev-parse", "--verify", ref])).trim();
  }

  // Staying current (PLAN 9.2): a finished branch waiting in review is rebased onto every new main and re-tested.
  async function stayCurrent(): Promise<void> {
    const main = await mainCommit();
    if (unsubscribe === null) return;
    for (const task of db.tasks.list())
      if (task.status === "review" && task.baseCommit !== main) moveToChecking(task, "current");
  }

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
          // Main may have moved after this task's checks rebased it, while they were still running.
          if (event.task.status === "review" && previous !== "review") stayCurrent().catch(onError);
        }
        if (
          (event.type === "scheduler.updated" || event.type === "auth.updated") &&
          claudeAllowed()
        )
          for (const taskId of [...waiting]) enqueue(taskId);
        if (event.type === "main.moved") stayCurrent().catch(onError);
      });
      for (const [taskId, status] of statuses) if (status === "checking") enqueue(taskId);
      stayCurrent().catch(onError);
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
      return moveToChecking(task, "full");
    },
  };
}
