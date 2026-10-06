import type { Clock } from "./clock.js";
import type {
  BusEvent,
  BusEventOf,
  RuntimeFlags,
  Session,
  SessionRole,
  SessionStatus,
  SubscriptionPlan,
  Summary,
  TaskStatus,
} from "./contracts/index.js";
import type { Db } from "./db/index.js";
import type { EventBus } from "./events.js";

export interface StatusHeader {
  repoName: string;
  mainBranch: string;
  mainCommit: string | null;
  email: string | null;
  plan: SubscriptionPlan;
  link: string;
}

export interface RunningSession {
  sessionId: number;
  label: string;
  role: SessionRole;
  attempt: number | null;
  model: string | null;
  startedAt: string;
  activity: string;
}

export interface EventLine {
  id: number;
  ts: string;
  label: string;
  text: string;
}

export interface StatusSnapshot {
  header: StatusHeader;
  running: readonly RunningSession[];
  summary: Summary;
  runningChecks: number;
  events: readonly EventLine[];
}

export interface StatusStore {
  getSnapshot(): StatusSnapshot;
  subscribe(listener: () => void): () => void;
  notice(text: string): void;
  dispose(): void;
}

export interface StatusStoreOptions {
  db: Db;
  bus: EventBus;
  clock: Clock;
  header: StatusHeader;
  summary: () => Summary;
  maxAttempts: () => number;
}

export const visibleEventLines = 5;

type Line = Pick<EventLine, "label" | "text">;

const sessionEndings: Record<Exclude<SessionStatus, "running">, string> = {
  succeeded: "finished",
  failed: "failed",
  stopped: "stopped",
  killed: "killed",
  rate_limited: "hit the usage limit",
  auth_failed: "lost its Claude sign-in",
};

const taskStatusLines: Partial<Record<TaskStatus, string>> = {
  review: "Waiting for review",
  blocked: "Blocked",
  done: "Done",
};

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function clockTime(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function sessionLabel(session: Pick<Session, "taskId" | "role">): string {
  return session.taskId ?? session.role;
}

function startLine(session: Session, maxAttempts: number): Line {
  const attempt =
    session.attempt === null
      ? ""
      : `, attempt ${String(session.attempt)} of ${String(maxAttempts)}`;
  return { label: sessionLabel(session), text: `Start ${session.role}${attempt}` };
}

function endLine(session: Session): Line | null {
  if (session.status === "running") return null;
  return {
    label: sessionLabel(session),
    text: `${capitalize(session.role)} ${sessionEndings[session.status]}`,
  };
}

function sessionEventLine({ taskId, event }: BusEventOf<"session.event">): Line | null {
  if (event.type !== "commit" && event.type !== "error") return null;
  return { label: taskId ?? "conductor", text: event.summary };
}

function checkLine({ taskId, check }: BusEventOf<"check.updated">): Line {
  return { label: taskId, text: `${capitalize(check.kind)} check ${check.status}` };
}

function rebaseLine(
  { taskId, rebase }: BusEventOf<"rebase.updated">,
  mainBranch: string,
): Line | null {
  if (rebase.status === "succeeded")
    return { label: "rebase", text: `${taskId} rebased onto ${mainBranch}` };
  if (rebase.status === "failed") return { label: "rebase", text: `${taskId} rebase failed` };
  return null;
}

function schedulerLines(
  previous: Pick<RuntimeFlags, "paused" | "backoffResumeAt">,
  { paused, resumeAt }: BusEventOf<"scheduler.updated">,
): Line[] {
  const lines: Line[] = [];
  if (paused !== previous.paused)
    lines.push({ label: "scheduler", text: paused ? "Paused" : "Resumed" });
  if (resumeAt !== previous.backoffResumeAt)
    lines.push({
      label: "scheduler",
      text:
        resumeAt === null
          ? "Usage limit wait is over"
          : `Usage limit reached; new sessions wait until ${clockTime(new Date(resumeAt))}`,
    });
  return lines;
}

function authLine({ authRequired }: BusEventOf<"auth.updated">): Line {
  return {
    label: "sign-in",
    text: authRequired
      ? "Your Claude sign-in expired. New sessions wait until you sign in again."
      : "Signed in again",
  };
}

export function createStatusStore(options: StatusStoreOptions): StatusStore {
  const { db, bus, clock, header } = options;
  const listeners = new Set<() => void>();
  const activity = new Map<number, string>();
  const runningChecks = new Set<number>();
  const taskStatuses = new Map(db.tasks.list().map((task) => [task.id, task.status]));
  let flags = db.flags.get();
  let events: EventLine[] = [];
  let nextLineId = 1;

  function readRunning(): RunningSession[] {
    return db.sessions
      .listRunning()
      .filter((session) => session.role !== "conductor")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id - b.id)
      .map((session) => ({
        sessionId: session.id,
        label: sessionLabel(session),
        role: session.role,
        attempt: session.attempt,
        model: session.model,
        startedAt: session.startedAt,
        activity: activity.get(session.id) ?? "Starting",
      }));
  }

  function read(): StatusSnapshot {
    return {
      header,
      running: readRunning(),
      summary: options.summary(),
      runningChecks: runningChecks.size,
      events,
    };
  }

  let snapshot = read();

  function publish(): void {
    snapshot = read();
    for (const listener of [...listeners]) listener();
  }

  function addLines(lines: readonly (Line | null)[]): void {
    const ts = clock.now().toISOString();
    const added = lines.flatMap((line) =>
      line === null ? [] : [{ ...line, id: nextLineId++, ts }],
    );
    if (added.length > 0) events = [...events, ...added].slice(-visibleEventLines);
  }

  function linesFor(event: BusEvent): (Line | null)[] | null {
    switch (event.type) {
      case "session.started":
        if (event.session.role === "conductor") return null;
        return [startLine(event.session, options.maxAttempts())];
      case "session.event":
        activity.set(event.sessionId, event.event.summary);
        return [sessionEventLine(event)];
      case "session.ended":
        activity.delete(event.sessionId);
        if (event.session.role === "conductor") return null;
        return [endLine(event.session)];
      case "task.updated": {
        const previous = taskStatuses.get(event.taskId);
        taskStatuses.set(event.taskId, event.task.status);
        const text = taskStatusLines[event.task.status];
        return previous === event.task.status || text === undefined
          ? []
          : [{ label: event.taskId, text }];
      }
      case "check.updated":
        if (event.check.status === "running") runningChecks.add(event.check.id);
        else runningChecks.delete(event.check.id);
        return [checkLine(event)];
      case "rebase.updated":
        return [rebaseLine(event, header.mainBranch)];
      case "scheduler.updated": {
        const lines = schedulerLines(flags, event);
        flags = { ...flags, paused: event.paused, backoffResumeAt: event.resumeAt };
        return lines;
      }
      case "auth.updated":
        return [authLine(event)];
      case "config.updated":
        return [];
      case "file.changed":
      case "workspace.changed":
      case "terminal.output":
      case "chat.message":
      case "chat.delta":
      case "chat.turn":
      case "proposal.updated":
      case "service.stopping":
        return null;
    }
  }

  const unsubscribe = bus.subscribe((event) => {
    const lines = linesFor(event);
    if (lines === null) return;
    addLines(lines);
    publish();
  });

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    notice(text) {
      addLines([{ label: "mastermind", text }]);
      publish();
    },

    dispose() {
      unsubscribe();
      listeners.clear();
    },
  };
}
