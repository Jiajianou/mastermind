import { postChatMessage } from "../chat.js";
import type { Clock } from "../clock.js";
import type { ResolvedConfig } from "../config/index.js";
import { isEditingRole } from "../contracts/index.js";
import type { EventLineMeta, Session } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { EventBus } from "../events.js";
import { claudeCallsAllowed } from "./effects.js";
import type { SessionManager } from "./manager.js";
import type { OneShotRunner } from "./one-shot.js";
import { attributionOff } from "./settings.js";
import { withoutFinalStop } from "./summary.js";
import { stuckCheckLineType, stuckJudgePrompt, stuckSignals, stuckVerdictSchema } from "./stuck.js";
import type { StuckJudgement } from "./stuck.js";

export const stuckJudgeModel = "sonnet";

export interface StuckMonitorOptions {
  db: Db;
  bus: EventBus;
  clock: Clock;
  oneShot: OneShotRunner;
  sessions: Pick<SessionManager, "restartStuck">;
  config: () => ResolvedConfig;
  onError: (error: unknown) => void;
  pollMs?: number;
}

export interface StuckMonitor {
  start(): void;
  stop(): void;
}

type EditingSession = Session & { taskId: string };

const isTaskEditor = (session: Session): session is EditingSession =>
  isEditingRole(session) && session.taskId !== null;

// No session has a time limit; one that runs long is checked after stuckCheck.after, then every stuckCheck.every.
export function createStuckMonitor(options: StuckMonitorOptions): StuckMonitor {
  const { db, bus, clock, onError, pollMs = 30_000 } = options;
  const nextCheckAt = new Map<number, number>();
  const checking = new Set<number>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function recordProgress(session: EditingSession, minutes: number, judgement: StuckJudgement) {
    if (db.sessions.get(session.id)?.status !== "running") return;
    const event = db.events.append({
      sessionId: session.id,
      type: "note",
      summary: `Checked at ${String(minutes)} min: still making progress`,
      payload: JSON.stringify({ type: stuckCheckLineType, minutes, ...judgement }),
    });
    bus.emit({ type: "session.event", sessionId: session.id, taskId: session.taskId, event });
  }

  function announceRestart(taskId: string, reason: string): void {
    postChatMessage(
      { db, bus },
      {
        kind: "system",
        content: `${taskId} was stuck: ${withoutFinalStop(reason)}; restarted with a different approach`,
        meta: { event: "stuck", taskId } satisfies EventLineMeta,
      },
    );
  }

  async function check(session: EditingSession, checkedAt: Date): Promise<void> {
    nextCheckAt.set(session.id, checkedAt.getTime() + options.config().stuckCheck.everyMs);
    const task = db.tasks.get(session.taskId);
    const worktree = task?.worktree ?? null;
    if (task === null || worktree === null) return;
    const events = db.events.listForSession(session.id);
    const signals = stuckSignals({ startedAt: session.startedAt, events, now: checkedAt });
    const result = await options.oneShot.run({
      role: "judge",
      taskId: task.id,
      round: session.round,
      cwd: worktree,
      prompt: stuckJudgePrompt({ task, session, signals, events }),
      schema: stuckVerdictSchema,
      print: {
        model: stuckJudgeModel,
        maxTurns: 1,
        tools: [],
        settings: { attribution: attributionOff },
      },
    });
    if (timer === null || result.kind === "failed") return;
    const judgement = result.value;
    if (!judgement.stuck) {
      recordProgress(session, signals.minutesRunning, judgement);
      return;
    }
    const restarted = await options.sessions.restartStuck(session.id, {
      reason: judgement.reason,
      suggestion: judgement.suggestion,
    });
    if (restarted !== null) announceRestart(task.id, judgement.reason);
  }

  function due(session: EditingSession, now: number): boolean {
    const first = Date.parse(session.startedAt) + options.config().stuckCheck.afterMs;
    return !checking.has(session.id) && now >= (nextCheckAt.get(session.id) ?? first);
  }

  function tick(): void {
    const running = db.sessions.listRunning().filter(isTaskEditor);
    const runningIds = new Set(running.map((session) => session.id));
    for (const id of nextCheckAt.keys()) if (!runningIds.has(id)) nextCheckAt.delete(id);
    const now = clock.now();
    if (!claudeCallsAllowed(db, now)) return;
    for (const session of running.filter((candidate) => due(candidate, now.getTime()))) {
      checking.add(session.id);
      check(session, now)
        .catch(onError)
        .finally(() => checking.delete(session.id));
    }
  }

  return {
    start() {
      timer ??= setInterval(() => {
        try {
          tick();
        } catch (error) {
          onError(error);
        }
      }, pollMs);
    },

    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
