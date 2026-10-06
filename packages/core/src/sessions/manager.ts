import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertTransition, ActionError } from "../actions/index.js";
import type { ClaudeCli, PrintOptions } from "../claude.js";
import { systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import { projectPaths } from "../config/index.js";
import type { ResolvedConfig } from "../config/index.js";
import { isEditingRole } from "../contracts/index.js";
import type { Check, MessageSessionResult, Session, Task } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { Environment } from "../env.js";
import type { EventBus } from "../events.js";
import { commitLeftovers, createTaskClone, deleteClone, headCommit } from "../git/index.js";
import type { Git } from "../git/index.js";
import type { ProcessRegistry } from "../procs.js";
import { canResumeConversation } from "./conversation.js";
import { resumePrompt, workerTaskPrompt } from "./prompts.js";
import { editingSessionSettings, workerPermissionOptions } from "./settings.js";
import { applySettlementEffect } from "./effects.js";
import type { UsageBackoff } from "./effects.js";
import { settleWorkerRun } from "./settlement.js";
import { runSetupCheck } from "./setup.js";
import { createSessionSpawner, userMessageLine } from "./spawner.js";
import type { LiveSession, SessionReport } from "./spawner.js";

export const wipMessage = "WIP: uncommitted at session end";

export interface SessionManagerOptions {
  db: Db;
  bus: EventBus;
  cli: ClaudeCli;
  git: Git;
  registry: ProcessRegistry;
  env: Environment;
  repoRoot: string;
  homeDir: string;
  promptsDir: string;
  config: () => ResolvedConfig;
  backoff: UsageBackoff;
  pathGuardCommand: readonly string[];
  onError: (error: unknown) => void;
  clock?: Clock;
  resultGraceMs?: number;
}

export interface FixerRequest {
  taskId: string;
  prompt: string;
  attempts: number;
}

export interface SessionManager {
  startTask(task: Task): Promise<void>;
  startFixer(request: FixerRequest): Promise<Session>;
  stopSession(sessionId: number): Promise<void>;
  messageSession(sessionId: number, text: string): Promise<MessageSessionResult>;
}

interface Workspace {
  path: string;
  setup: Check | null;
}

interface RunningSession {
  session: LiveSession;
  settled: Promise<void>;
}

type EditingRole = "worker" | "fixer";

interface WorkerLaunch {
  role: EditingRole;
  task: Task;
  worktree: string;
  print: PrintOptions;
  prompt: (running: Task) => string;
  attempt: number;
  attempts?: number;
  steer?: string;
}

const conflict = (message: string) => ActionError.fromMessage("conflict", message);

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const { db, bus, git, repoRoot, onError, clock = systemClock } = options;
  const logsDir = join(projectPaths(repoRoot).stateDir, "logs");
  const spawner = createSessionSpawner({
    db,
    bus,
    cli: options.cli,
    logsDir,
    onError,
    resultGraceMs: options.resultGraceMs,
  });
  const live = new Map<number, RunningSession>();
  let steering: Promise<unknown> = Promise.resolve();

  function requireTask(taskId: string): Task {
    const task = db.tasks.get(taskId);
    if (task === null) throw ActionError.fromMessage("not_found", `no task "${taskId}"`);
    return task;
  }

  function emitTask(task: Task): void {
    bus.emit({ type: "task.updated", taskId: task.id, task });
  }

  async function prepareWorkspace(task: Task, config: ResolvedConfig): Promise<Workspace> {
    if (task.worktree !== null && existsSync(task.worktree))
      return { path: task.worktree, setup: null };
    const path = join(config.worktreeDir, task.id);
    if (existsSync(path)) await deleteClone(path, config.worktreeDir);
    const clone = await createTaskClone(git, {
      repoRoot,
      mainBranch: config.mainBranch,
      taskId: task.id,
      path,
    });
    const command = config.commands.setup.trim();
    const setup =
      command === ""
        ? null
        : await runSetupCheck({
            db,
            bus,
            registry: options.registry,
            env: options.env,
            clock,
            logsDir,
            taskId: task.id,
            round: task.round,
            command,
            cwd: clone.path,
            onError,
          });
    emitTask(
      db.tasks.update(task.id, {
        worktree: clone.path,
        branch: clone.branch,
        baseCommit: clone.baseCommit,
      }),
    );
    return { path: clone.path, setup };
  }

  function editingPrint(
    role: EditingRole,
    config: ResolvedConfig,
    worktree: string,
    resume: string | null,
  ): PrintOptions {
    const session = resume === null ? { sessionId: randomUUID() } : { resume };
    return {
      model: config.models[role],
      inputFormat: "stream-json",
      ...session,
      replayUserMessages: true,
      ...workerPermissionOptions(config.workerPermissions, config.workerAllowedTools),
      noPermissionPrompts: true,
      appendSystemPromptFile: join(options.promptsDir, `${role}.md`),
      settings: editingSessionSettings({
        worktree,
        protectedPaths: [repoRoot, join(options.homeDir, ".claude")],
        sandbox: config.sandbox,
        pathGuardCommand: options.pathGuardCommand,
      }),
    };
  }

  function beginSession({
    role,
    task: { id: taskId },
    print,
    attempt,
    attempts,
    steer,
  }: WorkerLaunch): {
    session: Session;
    task: Task;
  } {
    const started = db.transaction(() => {
      const task = requireTask(taskId);
      assertTransition(taskId, task.status, "running");
      const session = db.sessions.create({
        role,
        taskId,
        round: task.round,
        attempt,
        claudeSessionId: print.sessionId ?? print.resume ?? null,
        model: print.model,
      });
      const steered =
        steer === undefined
          ? null
          : db.events.append({
              sessionId: session.id,
              type: "steer",
              summary: steer,
              payload: userMessageLine(steer),
            });
      return {
        session,
        steered,
        task: db.tasks.update(taskId, {
          status: "running",
          resumeSession: null,
          ...(attempts === undefined ? {} : { attempts }),
        }),
      };
    });
    emitTask(started.task);
    if (started.steered !== null)
      bus.emit({
        type: "session.event",
        sessionId: started.session.id,
        taskId,
        event: started.steered,
      });
    return started;
  }

  function abandonStart(session: Session, previous: Task): void {
    const [ended, task] = db.transaction(
      () =>
        [
          db.sessions.end(session.id, { status: "failed" }),
          db.tasks.update(previous.id, {
            status: previous.status,
            attempts: previous.attempts,
            resumeSession: previous.resumeSession,
          }),
        ] as const,
    );
    bus.emit({ type: "session.ended", sessionId: ended.id, taskId: ended.taskId, session: ended });
    emitTask(task);
  }

  async function recordWork(worktree: string, succeeded: boolean): Promise<string | null> {
    try {
      if (succeeded) await commitLeftovers(git, worktree, wipMessage);
      return await headCommit(git, worktree);
    } catch (error) {
      onError(error);
      return null;
    }
  }

  async function settle(
    taskId: string,
    session: Session,
    worktree: string,
    report: SessionReport,
  ): Promise<void> {
    const { end } = report;
    const succeeded = end.kind === "exited" && end.outcome.status === "succeeded";
    const endCommit = await recordWork(worktree, succeeded);
    const settlement = settleWorkerRun({
      report,
      task: requireTask(taskId),
      claudeSessionId: session.claudeSessionId,
      maxAttempts: options.config().maxAttempts,
    });
    const settled = db.transaction(() => {
      assertTransition(taskId, requireTask(taskId).status, settlement.task.status);
      const failure =
        settlement.failure === null
          ? null
          : db.events.append({
              sessionId: session.id,
              type: "error",
              summary: `Session failed: ${settlement.failure}`,
              payload: JSON.stringify(end),
            });
      return {
        failure,
        session: db.sessions.end(session.id, { status: settlement.sessionStatus, endCommit }),
        task: db.tasks.update(taskId, settlement.task),
      };
    });
    if (settled.failure !== null)
      bus.emit({ type: "session.event", sessionId: session.id, taskId, event: settled.failure });
    applySettlementEffect(settlement.effect, { db, bus, backoff: options.backoff });
    bus.emit({ type: "session.ended", sessionId: session.id, taskId, session: settled.session });
    emitTask(settled.task);
    if (end.kind === "exited" && report.undeliveredMessages.length > 0)
      redeliver(session, report.undeliveredMessages.join("\n\n"));
  }

  async function launchWorker(launch: WorkerLaunch): Promise<LiveSession> {
    const { session, task: running } = beginSession(launch);
    let started: LiveSession;
    try {
      started = await spawner.launch({
        session,
        cwd: launch.worktree,
        prompt: launch.prompt(running),
        print: launch.print,
      });
    } catch (error) {
      abandonStart(session, launch.task);
      throw error;
    }
    const settled = started.finished
      .finally(() => live.delete(session.id))
      .then((report) => settle(running.id, started.session, launch.worktree, report))
      .catch(onError);
    live.set(session.id, { session: started, settled });
    return started;
  }

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = steering.then(work);
    steering = next.catch(() => undefined);
    return next;
  }

  function steerableSession(sessionId: number): Session & { taskId: string } {
    const session = db.sessions.get(sessionId);
    if (session === null)
      throw ActionError.fromMessage("not_found", `no session ${String(sessionId)}`);
    const { taskId } = session;
    if (taskId === null || !isEditingRole(session))
      throw ActionError.fromMessage(
        "invalid_input",
        `session ${String(sessionId)} is a ${session.role} session; only worker and fixer sessions take messages`,
      );
    return { ...session, taskId };
  }

  function liveContinuation(session: Session): RunningSession | undefined {
    const exact = live.get(session.id);
    if (exact !== undefined || session.claudeSessionId === null) return exact;
    return [...live.values()].find(
      ({ session: { session: other } }) =>
        other.taskId === session.taskId && other.claudeSessionId === session.claudeSessionId,
    );
  }

  function assertResumable(session: Session & { taskId: string }, task: Task): string {
    const id = String(session.id);
    const claudeSessionId = session.claudeSessionId;
    if (claudeSessionId === null || !canResumeConversation(db, task.id, claudeSessionId))
      throw conflict(`session ${id} ended before its conversation started, so it can't be resumed`);
    const latest = db.sessions.listForTask(task.id).findLast(isEditingRole);
    if (latest !== undefined && latest.claudeSessionId !== claudeSessionId)
      throw conflict(
        `session ${id} is not the latest session of ${task.id}; message session ${String(latest.id)} instead`,
      );
    switch (task.status) {
      case "running":
        throw conflict(`${task.id} already has a running session`);
      case "rebasing":
        throw conflict(`${task.id} is being rebased onto main`);
      case "blocked":
        throw conflict(`${task.id} is blocked; retry it first`);
      case "done":
        throw conflict(`${task.id} is done`);
      case "pending":
      case "checking":
      case "review":
        break;
    }
    if (task.worktree === null || !existsSync(task.worktree))
      throw conflict(`the workspace of ${task.id} is gone`);
    const flags = db.flags.get();
    if (flags.authRequired) throw conflict("sign-in is needed before a session can resume");
    if (flags.backoffResumeAt !== null && new Date(flags.backoffResumeAt) > clock.now())
      throw conflict(`work is backing off after a usage limit until ${flags.backoffResumeAt}`);
    return task.worktree;
  }

  async function resumeWithMessage(
    session: Session & { taskId: string },
    text: string,
  ): Promise<MessageSessionResult> {
    const task = requireTask(session.taskId);
    const worktree = assertResumable(session, task);
    const role = session.role === "fixer" ? "fixer" : "worker";
    const started = await launchWorker({
      role,
      task,
      worktree,
      print: editingPrint(role, options.config(), worktree, session.claudeSessionId),
      prompt: () => text,
      attempt: session.attempt ?? task.attempts + 1,
      steer: text,
    });
    return { delivery: "resumed", session: started.session };
  }

  async function deliver(sessionId: number, text: string): Promise<MessageSessionResult> {
    const target = steerableSession(sessionId);
    const running = liveContinuation(target);
    if (running !== undefined) {
      if (running.session.steer(text)) {
        const session = db.sessions.get(running.session.session.id) ?? running.session.session;
        return { delivery: "live", session };
      }
      await running.settled;
    }
    return resumeWithMessage(target, text);
  }

  // A message written to stdin that the CLI hadn't taken in when the turn ended is sent again by resuming.
  function redeliver(session: Session, text: string): void {
    serialized(() => deliver(session.id, text)).catch((error: unknown) => {
      if (!(error instanceof ActionError)) {
        onError(error);
        return;
      }
      const event = db.events.append({
        sessionId: session.id,
        type: "error",
        summary: `Message not delivered: ${error.message}`,
        payload: JSON.stringify({ type: "steer", text, error: error.message }),
      });
      bus.emit({ type: "session.event", sessionId: session.id, taskId: session.taskId, event });
    });
  }

  return {
    async startTask(scheduled) {
      const config = options.config();
      const pending = requireTask(scheduled.id);
      assertTransition(pending.id, pending.status, "running");
      const workspace = await prepareWorkspace(pending, config);
      const task = requireTask(scheduled.id);
      await launchWorker({
        role: "worker",
        task,
        worktree: workspace.path,
        print: editingPrint("worker", config, workspace.path, task.resumeSession),
        prompt: (running) =>
          task.resumeSession === null ? workerTaskPrompt(running, workspace.setup) : resumePrompt,
        attempt: task.attempts + 1,
      });
    },

    async startFixer({ taskId, prompt, attempts }) {
      const task = requireTask(taskId);
      assertTransition(taskId, task.status, "running");
      const { worktree } = task;
      if (worktree === null || !existsSync(worktree))
        throw conflict(`the workspace of ${taskId} is gone`);
      const started = await launchWorker({
        role: "fixer",
        task,
        worktree,
        print: editingPrint("fixer", options.config(), worktree, null),
        prompt: () => prompt,
        attempt: attempts + 1,
        attempts,
      });
      return started.session;
    },

    async stopSession(sessionId) {
      const running = live.get(sessionId);
      if (running === undefined)
        throw ActionError.fromMessage("not_found", `no running session ${String(sessionId)}`);
      await running.session.stop();
      await running.settled;
    },

    messageSession(sessionId, text) {
      return serialized(() => deliver(sessionId, text));
    },
  };
}
