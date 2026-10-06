import { existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { errorMessage } from "../contracts/index.js";
import { assertTransition } from "../actions/index.js";
import { findAttribution } from "../attribution.js";
import { checkFailureRequest, conflictRequest, readFailedCheck } from "../checks/fixing.js";
import type { FixerLauncher, FixRequest } from "../checks/fixing.js";
import { abortRebase, rebaseOntoMain } from "../checks/rebase.js";
import { fileStamp, runShellCheck } from "../checks/runner.js";
import type { CheckContext } from "../checks/runner.js";
import { systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import type { ResolvedConfig } from "../config/index.js";
import type { CheckKind, Rebase, Task, TaskStatus } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { Environment } from "../env.js";
import type { EventBus } from "../events.js";
import { deleteClone, fetchTaskIntoRepo, taskRef } from "../git/index.js";
import type { Git } from "../git/index.js";
import type { ProcessRegistry } from "../procs.js";
import { deleteRef, fastForwardMain, mainCheckedOut } from "./main-ref.js";
import { squashBranch } from "./squash.js";

export interface RebaseQueueOptions {
  db: Db;
  bus: EventBus;
  git: Git;
  registry: ProcessRegistry;
  env: Environment;
  repoRoot: string;
  logsDir: string;
  config: () => ResolvedConfig;
  launcher: FixerLauncher;
  onError: (error: unknown) => void;
  clock?: Clock;
  checkoutPollMs?: number;
}

export interface RebaseQueue {
  start(): void;
  stop(): void;
}

type Outcome =
  | { kind: "rebased"; commit: string | null }
  | ({ kind: "fix" } & FixRequest)
  | { kind: "block"; reason: string }
  | { kind: "stopped" };

interface Run {
  task: Task;
  worktree: string;
  config: ResolvedConfig;
  signal: AbortSignal;
  note(text: string): Promise<void>;
}

const maxFastForwardTries = 5;
const stopped: Outcome = { kind: "stopped" };

export function createRebaseQueue(options: RebaseQueueOptions): RebaseQueue {
  const { db, bus, git, repoRoot, launcher, onError, clock = systemClock } = options;
  const checkoutPollMs = options.checkoutPollMs ?? 2_000;
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

  const queue: string[] = [];
  const parked = new Map<string, FixRequest>();
  const statuses = new Map<string, TaskStatus>();
  let active: string | null = null;
  let draining = false;
  let ownerOnMain = false;
  let stopping = new AbortController();
  let unsubscribe: (() => void) | null = null;

  function emitTask(task: Task): void {
    bus.emit({ type: "task.updated", taskId: task.id, task });
  }

  function emitRebase(rebase: Rebase): void {
    bus.emit({ type: "rebase.updated", taskId: rebase.taskId, rebase });
  }

  function setOwnerOnMain(onMain: boolean, branch: string): void {
    if (onMain === ownerOnMain) return;
    ownerOnMain = onMain;
    bus.emit({ type: "checkout.updated", branch, onMain });
  }

  // Moving main under the owner's checkout would leave their files behind its HEAD (decision 6), so rebasing onto
  // main waits until they switch away.
  async function waitUntilMainIsFree(run: Run): Promise<boolean> {
    const { mainBranch } = run.config;
    while (await mainCheckedOut(git, repoRoot, mainBranch)) {
      if (!ownerOnMain)
        await run.note(`${mainBranch} is checked out; waiting until the owner switches away.`);
      setOwnerOnMain(true, mainBranch);
      try {
        await sleep(checkoutPollMs, undefined, { signal: run.signal });
      } catch (error) {
        if (run.signal.aborted) return false;
        throw error;
      }
    }
    setOwnerOnMain(false, mainBranch);
    return true;
  }

  async function runCommand(run: Run, kind: CheckKind, command: string): Promise<Outcome | null> {
    if (command === "") return null;
    const target = { taskId: run.task.id, round: run.task.round, kind, cwd: run.worktree };
    const check = await runShellCheck(context, { ...target, command });
    if (check.status === "passed") return null;
    return { kind: "fix", ...checkFailureRequest(run.task, await readFailedCheck(check)) };
  }

  async function attributionIn(upstream: string, taskId: string): Promise<string | null> {
    const messages = await git.run(repoRoot, [
      "log",
      "--format=%B",
      `${upstream}..${taskRef(taskId)}`,
    ]);
    return findAttribution(messages)[0]?.text ?? null;
  }

  async function rebaseOnce(run: Run): Promise<Outcome | { kind: "moved" }> {
    const { task, worktree, config } = run;
    const { mainBranch, commands } = config;
    await abortRebase(git, worktree);
    const rebase = await rebaseOntoMain(context, {
      taskId: task.id,
      round: task.round,
      worktree,
      repoRoot,
      mainBranch,
    });
    const { upstream } = rebase;
    if (rebase.kind === "conflict") {
      await run.note(`Conflict rebasing onto ${mainBranch} at ${upstream}; a fixer takes over.`);
      const fixerGaveUp = launcher.followsConflictFixer(task.id);
      const request = await conflictRequest(task, {
        check: rebase.check,
        upstream,
        mainBranch,
        fixerGaveUp,
      });
      return { kind: "fix", ...request };
    }
    if (task.baseCommit !== upstream) {
      run.task = db.tasks.update(task.id, { baseCommit: upstream });
      emitTask(run.task);
    }
    await run.note(`Rebased onto ${mainBranch} at ${upstream}.`);

    const squash = await squashBranch(git, { task, worktree, upstream });
    if (squash.kind === "empty") {
      await run.note(`The branch changes nothing on ${mainBranch}, so there is nothing to add.`);
      return { kind: "rebased", commit: null };
    }
    await run.note(`Squashed into ${squash.commit}: ${squash.subject}`);

    const build = await runCommand(run, "build", commands.build.trim());
    if (build !== null) return build;
    const suite = await runCommand(run, "suite", commands.test.trim());
    if (suite !== null) return suite;

    const fetched = await fetchTaskIntoRepo(git, {
      repoRoot,
      taskId: task.id,
      clonePath: worktree,
    });
    const attribution = await attributionIn(upstream, task.id);
    if (attribution !== null) {
      await deleteRef(git, repoRoot, taskRef(task.id));
      return {
        kind: "block",
        reason: `its commit message has an attribution line: ${attribution}`,
      };
    }
    await run.note(
      `Attribution guard: no attribution in ${upstream.slice(0, 7)}..${taskRef(task.id)}.`,
    );

    if (!(await waitUntilMainIsFree(run))) return stopped;
    const forward = await fastForwardMain(git, {
      repoRoot,
      mainBranch,
      subject: task.id,
      from: upstream,
      to: fetched,
    });
    if (forward.kind === "moved") {
      await run.note(`${mainBranch} moved to ${forward.current} meanwhile; rebasing again.`);
      return { kind: "moved" };
    }
    await run.note(`Fast-forwarded ${mainBranch} from ${upstream} to ${fetched}.`);
    return { kind: "rebased", commit: fetched };
  }

  async function rebaseTask(run: Run): Promise<Outcome> {
    for (let tries = 1; tries <= maxFastForwardTries; tries++) {
      if (!(await waitUntilMainIsFree(run))) return stopped;
      const outcome = await rebaseOnce(run);
      if (outcome.kind !== "moved") return outcome;
    }
    const tries = String(maxFastForwardTries);
    return { kind: "block", reason: `${run.config.mainBranch} kept moving during ${tries} tries` };
  }

  function stillRebasing(taskId: string): Task | null {
    const task = db.tasks.get(taskId);
    return task?.status === "rebasing" ? task : null;
  }

  async function cleanUp(task: Task, config: ResolvedConfig): Promise<void> {
    try {
      await deleteRef(git, repoRoot, taskRef(task.id));
      if (task.worktree !== null) await deleteClone(task.worktree, config.worktreeDir);
    } catch (error) {
      onError(error);
    }
  }

  async function finishRebased(run: Run, rebase: Rebase, commit: string | null): Promise<void> {
    const done = db.transaction(() => {
      const task = stillRebasing(run.task.id);
      if (task === null) return null;
      assertTransition(task.id, task.status, "done");
      return {
        task: db.tasks.update(task.id, { status: "done" }),
        rebase: db.rebases.finish(rebase.id, "succeeded"),
      };
    });
    if (done === null) return;
    emitRebase(done.rebase);
    if (commit !== null) bus.emit({ type: "main.moved", branch: run.config.mainBranch, commit });
    emitTask(done.task);
    await cleanUp(done.task, run.config);
  }

  async function fix(taskId: string, request: FixRequest): Promise<void> {
    if ((await launcher.fix(taskId, "rebasing", request)) === "waiting")
      parked.set(taskId, request);
  }

  async function settle(run: Run, rebase: Rebase, outcome: Outcome): Promise<void> {
    if (outcome.kind === "stopped" || run.signal.aborted) return;
    if (outcome.kind === "rebased") {
      await finishRebased(run, rebase, outcome.commit);
      return;
    }
    emitRebase(db.rebases.finish(rebase.id, "failed"));
    if (outcome.kind === "fix") await fix(run.task.id, outcome);
    else launcher.block(run.task.id, "rebasing", run.task.attempts, outcome.reason);
  }

  // A shutdown mid-run leaves its row running; the task is still rebasing and is rebased again from the start.
  function failInterruptedRuns(taskId: string): void {
    for (const rebase of db.rebases.listForTask(taskId))
      if (rebase.status === "running") emitRebase(db.rebases.finish(rebase.id, "failed"));
  }

  async function openRun(task: Task, worktree: string): Promise<{ run: Run; rebase: Rebase }> {
    const logDir = join(options.logsDir, "rebases");
    const logPath = join(logDir, `${task.id}-${fileStamp(clock.now())}.log`);
    await mkdir(logDir, { recursive: true });
    const rebase = db.rebases.create({ taskId: task.id, logPath });
    emitRebase(rebase);
    const note = (text: string) => appendFile(logPath, `${text}\n`);
    const run = { task, worktree, config: options.config(), signal: stopping.signal, note };
    return { run, rebase };
  }

  async function runTask(taskId: string): Promise<void> {
    const task = stillRebasing(taskId);
    if (task === null) return;
    failInterruptedRuns(taskId);
    const { worktree } = task;
    if (worktree === null || !existsSync(worktree)) {
      launcher.block(taskId, "rebasing", task.attempts, "its workspace is gone");
      return;
    }
    const { run, rebase } = await openRun(task, worktree);
    let outcome: Outcome;
    try {
      outcome = await rebaseTask(run);
    } catch (error) {
      onError(error);
      await run.note(`Failed: ${errorMessage(error)}`).catch(onError);
      outcome = { kind: "block", reason: `its rebase onto main failed: ${errorMessage(error)}` };
    }
    await settle(run, rebase, outcome);
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      for (let taskId = queue.shift(); taskId !== undefined; taskId = queue.shift()) {
        if (unsubscribe === null) break;
        active = taskId;
        try {
          await runTask(taskId);
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

  function enqueue(taskId: string): void {
    if (unsubscribe === null || queue.includes(taskId) || active === taskId) return;
    parked.delete(taskId);
    queue.push(taskId);
    Promise.resolve().then(drain).catch(onError);
  }

  function launchParked(): void {
    if (!launcher.claudeAllowed()) return;
    for (const [taskId, request] of [...parked]) {
      parked.delete(taskId);
      fix(taskId, request).catch(onError);
    }
  }

  return {
    start() {
      if (unsubscribe !== null) return;
      stopping = new AbortController();
      for (const task of db.tasks.list()) statuses.set(task.id, task.status);
      unsubscribe = bus.subscribe((event) => {
        if (event.type === "task.updated") {
          const previous = statuses.get(event.taskId);
          statuses.set(event.taskId, event.task.status);
          if (event.task.status === "rebasing" && previous !== "rebasing") enqueue(event.taskId);
        }
        if (event.type === "scheduler.updated" || event.type === "auth.updated") launchParked();
      });
      for (const [taskId, status] of statuses) if (status === "rebasing") enqueue(taskId);
    },

    stop() {
      unsubscribe?.();
      unsubscribe = null;
      queue.length = 0;
      stopping.abort();
    },
  };
}
