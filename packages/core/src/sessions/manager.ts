import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertTransition, ActionError } from "../actions/index.js";
import type { ClaudeCli, PrintOptions } from "../claude.js";
import { systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import { projectPaths } from "../config/index.js";
import type { ResolvedConfig } from "../config/index.js";
import { isEditingRole } from "../contracts/index.js";
import type {
  Check,
  MessageSessionResult,
  Round,
  RoundMode,
  Session,
  Task,
} from "../contracts/index.js";
import type { Db, NewRound } from "../db/index.js";
import type { Environment } from "../env.js";
import type { EventBus } from "../events.js";
import {
  commitLeftovers,
  createTaskClone,
  deleteClone,
  headCommit,
  listChanges,
} from "../git/index.js";
import type { Git } from "../git/index.js";
import type { ProcessRegistry } from "../procs.js";
import { refinePrompt } from "../review/prompts.js";
import { canResumeConversation } from "./conversation.js";
import { editingPrintOptions } from "./editing-print.js";
import type { EditingRole, SystemPrompt } from "./editing-print.js";
import { resumePrompt, stuckRestartPrompt, workerTaskPrompt } from "./prompts.js";
import { applySettlementEffect } from "./effects.js";
import type { UsageBackoff } from "./effects.js";
import { settleWorkerRun } from "./settlement.js";
import type { WorkerSettlement } from "./settlement.js";
import { runSetupCheck } from "./setup.js";
import { createSessionSpawner, userMessageLine } from "./spawner.js";
import type { LiveSession, SessionReport, StuckVerdict } from "./spawner.js";

export const wipMessage = "WIP: uncommitted at session end";
export const stuckWipMessage = "WIP: uncommitted when the session got stuck";

const maxStuckDiffCharacters = 60_000;

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

export type RoundRecord = Pick<
  NewRound,
  "instruction" | "commentIds" | "findingIds" | "failingCheckId"
>;

export interface RoundRequest {
  taskId: string;
  mode: RoundMode;
  message: string;
  sent: RoundRecord;
}

export interface StartedRound {
  task: Task;
  session: Session;
  round: Round;
}

export interface SessionManager {
  startTask(task: Task): Promise<void>;
  startFixer(request: FixerRequest): Promise<Session>;
  startRound(request: RoundRequest): Promise<StartedRound>;
  stopSession(sessionId: number): Promise<void>;
  restartStuck(sessionId: number, verdict: StuckVerdict): Promise<Session | null>;
  messageSession(sessionId: number, text: string): Promise<MessageSessionResult>;
}

interface Workspace {
  path: string;
  setup: Check | null;
  reused: boolean;
}

interface RunningSession {
  session: LiveSession;
  settled: Promise<Session | null>;
}

interface Steer {
  summary: string;
  text: string;
}

type NextRound = Omit<NewRound, "taskId" | "round" | "sessionId">;

interface WorkerLaunch {
  role: EditingRole;
  task: Task;
  worktree: string;
  print: PrintOptions;
  prompt: (running: Task) => string;
  attempt: number;
  attempts?: number;
  steer?: Steer;
  nextRound?: NextRound;
}

interface Launched {
  live: LiveSession;
  task: Task;
  round: Round | null;
}

const conflict = (message: string) => ActionError.fromMessage("conflict", message);

export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const { db, bus, git, repoRoot, onError, clock = systemClock } = options;
  const logsDir = projectPaths(repoRoot).logs;
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
      return { path: task.worktree, setup: null, reused: true };
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
    return { path: clone.path, setup, reused: false };
  }

  function editingPrint(
    role: EditingRole,
    config: ResolvedConfig,
    worktree: string,
    resume: string | null,
    systemPrompt: SystemPrompt = role,
  ): PrintOptions {
    return editingPrintOptions(options, { role, config, worktree, resume, systemPrompt });
  }

  function beginSession({
    role,
    task: { id: taskId },
    print,
    attempt,
    attempts,
    steer,
    nextRound,
  }: WorkerLaunch): {
    session: Session;
    task: Task;
    round: Round | null;
  } {
    const started = db.transaction(() => {
      const task = requireTask(taskId);
      if (nextRound !== undefined && task.status !== "review")
        throw conflict(`only a task in review can start a new round; ${taskId} is ${task.status}`);
      assertTransition(taskId, task.status, "running");
      const roundNumber = nextRound === undefined ? task.round : task.round + 1;
      const session = db.sessions.create({
        role,
        taskId,
        round: roundNumber,
        attempt,
        claudeSessionId: print.sessionId ?? print.resume ?? null,
        model: print.model,
      });
      const round =
        nextRound === undefined
          ? null
          : db.rounds.create({ ...nextRound, taskId, round: roundNumber, sessionId: session.id });
      const steered =
        steer === undefined
          ? null
          : db.events.append({
              sessionId: session.id,
              type: "steer",
              summary: steer.summary,
              payload: userMessageLine(steer.text),
            });
      return {
        session,
        steered,
        round,
        task: db.tasks.update(taskId, {
          status: "running",
          resumeSession: null,
          round: roundNumber,
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

  function abandonStart(session: Session, previous: Task, round: Round | null): void {
    const [ended, task] = db.transaction(() => {
      if (round !== null) db.rounds.delete(round.id);
      return [
        db.sessions.end(session.id, { status: "failed" }),
        db.tasks.update(previous.id, {
          status: previous.status,
          attempts: previous.attempts,
          resumeSession: previous.resumeSession,
          round: previous.round,
        }),
      ] as const;
    });
    bus.emit({ type: "session.ended", sessionId: ended.id, taskId: ended.taskId, session: ended });
    emitTask(task);
  }

  async function recordWork(worktree: string, wip: string | null): Promise<string | null> {
    try {
      if (wip !== null) await commitLeftovers(git, worktree, wip);
      return await headCommit(git, worktree);
    } catch (error) {
      onError(error);
      return null;
    }
  }

  function wipFor(end: SessionReport["end"]): string | null {
    if (end.kind === "stuck") return stuckWipMessage;
    return end.kind === "exited" && end.outcome.status === "succeeded" ? wipMessage : null;
  }

  async function stuckPrompt(
    task: Task,
    worktree: string,
    verdict: StuckVerdict,
  ): Promise<(running: Task) => string> {
    const baseCommit = task.baseCommit ?? (await headCommit(git, worktree));
    const changes = await listChanges(git, worktree, baseCommit);
    const diff = await git.run(worktree, [
      "--no-optional-locks",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      baseCommit,
    ]);
    const material = {
      mainBranch: options.config().mainBranch,
      baseCommit,
      changes,
      diff: diff.slice(0, maxStuckDiffCharacters),
      diffTruncated: diff.length > maxStuckDiffCharacters,
      reason: verdict.reason,
      suggestion: verdict.suggestion,
    };
    return (running) => stuckRestartPrompt(running, material);
  }

  // A stuck session is replaced by a fresh one, so its context doesn't carry over (decision 17).
  async function preparedStuckRestart(
    task: Task,
    worktree: string,
    end: SessionReport["end"],
    settlement: WorkerSettlement,
  ): Promise<((running: Task) => string) | null> {
    if (end.kind !== "stuck" || settlement.task.status !== "pending" || settlement.task.held)
      return null;
    try {
      return await stuckPrompt(task, worktree, end);
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
  ): Promise<Session | null> {
    const { end } = report;
    const endCommit = await recordWork(worktree, wipFor(end));
    const task = requireTask(taskId);
    const settlement = settleWorkerRun({
      report,
      task,
      claudeSessionId: session.claudeSessionId,
      maxAttempts: options.config().maxAttempts,
    });
    const restartPrompt = await preparedStuckRestart(task, worktree, end, settlement);
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
    if (restartPrompt !== null) return restartStuckTask(settled.task, worktree, restartPrompt);
    emitTask(settled.task);
    if (end.kind === "exited" && report.undeliveredMessages.length > 0)
      redeliver(session, report.undeliveredMessages.join("\n\n"));
    return null;
  }

  // Runs in the same tick as the settlement, so the scheduler never sees the task pending in between.
  async function restartStuckTask(
    task: Task,
    worktree: string,
    prompt: (running: Task) => string,
  ): Promise<Session | null> {
    try {
      const started = await launchWorker({
        role: "worker",
        task,
        worktree,
        print: editingPrint("worker", options.config(), worktree, null),
        prompt,
        attempt: task.attempts + 1,
      });
      return started.live.session;
    } catch (error) {
      onError(error);
      emitTask(requireTask(task.id));
      return null;
    }
  }

  async function launchWorker(launch: WorkerLaunch): Promise<Launched> {
    const { session, task: running, round } = beginSession(launch);
    let started: LiveSession;
    try {
      started = await spawner.launch({
        session,
        cwd: launch.worktree,
        prompt: launch.prompt(running),
        print: launch.print,
      });
    } catch (error) {
      abandonStart(session, launch.task, round);
      throw error;
    }
    const settled = started.finished
      .finally(() => live.delete(session.id))
      .then((report) => settle(running.id, started.session, launch.worktree, report))
      .catch((error: unknown) => {
        onError(error);
        return null;
      });
    live.set(session.id, { session: started, settled });
    return { live: started, task: running, round };
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

  // An explicit instruction from the owner starts at once, even while work is paused, unless it couldn't run.
  function startableWorkspace(task: Task): string {
    if (task.worktree === null || !existsSync(task.worktree))
      throw conflict(`the workspace of ${task.id} is gone`);
    const flags = db.flags.get();
    if (flags.authRequired) throw conflict("sign-in is needed before a session can start");
    if (flags.backoffResumeAt !== null && new Date(flags.backoffResumeAt) > clock.now())
      throw conflict(`work is backing off after a usage limit until ${flags.backoffResumeAt}`);
    return task.worktree;
  }

  function latestConversation(task: Task): Session & { claudeSessionId: string } {
    const latest = db.sessions.listForTask(task.id).findLast(isEditingRole);
    const claudeSessionId = latest?.claudeSessionId ?? null;
    if (
      latest === undefined ||
      claudeSessionId === null ||
      !canResumeConversation(db, task.id, claudeSessionId)
    )
      throw conflict(`${task.id} has no session to continue; start a fresh session instead`);
    return { ...latest, claudeSessionId };
  }

  async function freshRoundPrompt(task: Task, worktree: string, request: string) {
    const config = options.config();
    const baseCommit = task.baseCommit ?? (await headCommit(git, worktree));
    const changes = await listChanges(git, worktree, baseCommit);
    return (running: Task) =>
      refinePrompt(running, { mainBranch: config.mainBranch, baseCommit, changes, request });
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
    return startableWorkspace(task);
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
      steer: { summary: text, text },
    });
    return { delivery: "resumed", session: started.live.session };
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
      const resume = task.resumeSession;
      // A later round that has to start over in its own clone (its session failed) starts fresh from the round's
      // request; a new clone (after a discard) holds none of that work, so it starts the task from the top.
      const round = resume === null && workspace.reused ? db.rounds.get(task.id, task.round) : null;
      await launchWorker({
        role: "worker",
        task,
        worktree: workspace.path,
        print: editingPrint(
          "worker",
          config,
          workspace.path,
          resume,
          round === null ? "worker" : "refine",
        ),
        prompt:
          resume !== null
            ? () => resumePrompt
            : round === null
              ? (running) => workerTaskPrompt(running, workspace.setup)
              : await freshRoundPrompt(task, workspace.path, round.message),
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
      return started.live.session;
    },

    async startRound({ taskId, mode, message, sent }) {
      const task = requireTask(taskId);
      if (task.status !== "review")
        throw conflict(`only a task in review can start a new round; ${taskId} is ${task.status}`);
      const worktree = startableWorkspace(task);
      const resumed = mode === "resume" ? latestConversation(task) : null;
      const role = resumed?.role === "fixer" ? "fixer" : "worker";
      const config = options.config();
      const startCommit = await headCommit(git, worktree);
      const next = String(task.round + 1);
      const started = await launchWorker({
        role,
        task,
        worktree,
        print: editingPrint(
          role,
          config,
          worktree,
          resumed?.claudeSessionId ?? null,
          resumed === null ? "refine" : role,
        ),
        prompt: resumed === null ? await freshRoundPrompt(task, worktree, message) : () => message,
        attempt: 1,
        attempts: 0,
        steer: { summary: `Changes requested for round ${next}`, text: message },
        nextRound: { ...sent, mode, message, startCommit },
      });
      const { round } = started;
      if (round === null) throw new Error(`round ${next} of ${taskId} was not recorded`);
      return { task: started.task, session: started.live.session, round };
    },

    async restartStuck(sessionId, verdict) {
      const running = live.get(sessionId);
      if (running?.session.stopAsStuck(verdict) !== true) return null;
      return running.settled;
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
