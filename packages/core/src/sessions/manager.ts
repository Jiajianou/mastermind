import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertTransition, ActionError } from "../actions/index.js";
import type { ClaudeCli, PrintOptions } from "../claude.js";
import { systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import { projectPaths } from "../config/index.js";
import type { ResolvedConfig } from "../config/index.js";
import type { Check, Session, Task } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { Environment } from "../env.js";
import type { EventBus } from "../events.js";
import { commitLeftovers, createTaskClone, deleteClone, headCommit } from "../git/index.js";
import type { Git } from "../git/index.js";
import type { ProcessRegistry } from "../procs.js";
import { resumePrompt, workerTaskPrompt } from "./prompts.js";
import { editingSessionSettings, workerPermissionOptions } from "./settings.js";
import { settleWorkerRun } from "./settlement.js";
import type { WorkerSettlement } from "./settlement.js";
import { runSetupCheck } from "./setup.js";
import { createSessionSpawner } from "./spawner.js";
import type { LiveSession, SessionReport } from "./spawner.js";

export const wipMessage = "WIP: uncommitted at session end";

export interface UsageBackoff {
  reportUsageLimit(resetAt?: Date): Date;
  reportSuccess(): void;
}

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

export interface SessionManager {
  startTask(task: Task): Promise<void>;
  stopSession(sessionId: number): Promise<void>;
}

interface Workspace {
  path: string;
  setup: Check | null;
}

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
  const live = new Map<number, LiveSession>();

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

  function workerPrint(config: ResolvedConfig, worktree: string, task: Task): PrintOptions {
    const session =
      task.resumeSession === null ? { sessionId: randomUUID() } : { resume: task.resumeSession };
    return {
      model: config.models.worker,
      inputFormat: "stream-json",
      ...session,
      replayUserMessages: true,
      ...workerPermissionOptions(config.workerPermissions, config.workerAllowedTools),
      noPermissionPrompts: true,
      appendSystemPromptFile: join(options.promptsDir, "worker.md"),
      settings: editingSessionSettings({
        worktree,
        protectedPaths: [repoRoot, join(options.homeDir, ".claude")],
        sandbox: config.sandbox,
        pathGuardCommand: options.pathGuardCommand,
      }),
    };
  }

  function beginSession(taskId: string, print: PrintOptions): { session: Session; task: Task } {
    const started = db.transaction(() => {
      const task = requireTask(taskId);
      assertTransition(taskId, task.status, "running");
      const session = db.sessions.create({
        role: "worker",
        taskId,
        round: task.round,
        attempt: task.attempts + 1,
        claudeSessionId: print.sessionId ?? print.resume ?? null,
        model: print.model,
      });
      return { session, task: db.tasks.update(taskId, { status: "running", resumeSession: null }) };
    });
    emitTask(started.task);
    return started;
  }

  function abandonStart(session: Session, previous: Task): void {
    const [ended, task] = db.transaction(
      () =>
        [
          db.sessions.end(session.id, { status: "failed" }),
          db.tasks.update(previous.id, {
            status: "pending",
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

  function applyEffect({ effect }: WorkerSettlement): void {
    switch (effect.kind) {
      case "succeeded":
        options.backoff.reportSuccess();
        return;
      case "usage-limit":
        options.backoff.reportUsageLimit(effect.resetAt ?? undefined);
        return;
      case "backoff":
        options.backoff.reportUsageLimit();
        return;
      case "auth-required": {
        const flags = db.flags.set({ authRequired: true, paused: true });
        bus.emit({ type: "auth.updated", authRequired: flags.authRequired });
        bus.emit({
          type: "scheduler.updated",
          paused: flags.paused,
          resumeAt: flags.backoffResumeAt,
        });
        return;
      }
      case "none":
        return;
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
    applyEffect(settlement);
    bus.emit({ type: "session.ended", sessionId: session.id, taskId, session: settled.session });
    emitTask(settled.task);
  }

  return {
    async startTask(scheduled) {
      const config = options.config();
      const pending = requireTask(scheduled.id);
      assertTransition(pending.id, pending.status, "running");
      const workspace = await prepareWorkspace(pending, config);
      const task = requireTask(scheduled.id);
      const print = workerPrint(config, workspace.path, task);
      const { session, task: running } = beginSession(task.id, print);
      let started: LiveSession;
      try {
        started = await spawner.launch({
          session,
          cwd: workspace.path,
          prompt:
            task.resumeSession === null ? workerTaskPrompt(running, workspace.setup) : resumePrompt,
          print,
        });
      } catch (error) {
        abandonStart(session, task);
        throw error;
      }
      live.set(session.id, started);
      started.finished
        .finally(() => live.delete(session.id))
        .then((report) => settle(task.id, started.session, workspace.path, report))
        .catch(onError);
    },

    async stopSession(sessionId) {
      const session = live.get(sessionId);
      if (session === undefined)
        throw ActionError.fromMessage("not_found", `no running session ${String(sessionId)}`);
      await session.stop();
    },
  };
}
