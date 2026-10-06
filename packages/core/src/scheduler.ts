import { setBackoff } from "./actions/index.js";
import type { SchedulerScope } from "./actions/index.js";
import type {
  BusEventType,
  RuntimeFlags,
  Session,
  Summary,
  Task,
  TaskStatus,
} from "./contracts/index.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db/index.js";
import type { EventBus } from "./events.js";

export interface SchedulerState {
  tasks: readonly Task[];
  sessions: readonly Pick<Session, "role" | "status">[];
  flags: RuntimeFlags;
  starting: readonly string[];
  maxWorkers: number;
  now: Date;
}

const occupyingStatuses: ReadonlySet<TaskStatus> = new Set([
  "running",
  "checking",
  "review",
  "rebasing",
]);

function pathSegments(path: string): string[] {
  return path.split("/").filter((segment) => segment !== "" && segment !== ".");
}

function isSegmentPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}

export function touchesOverlap(first: readonly string[], second: readonly string[]): boolean {
  return first.some((a) =>
    second.some((b) => {
      const [left, right] = [pathSegments(a), pathSegments(b)];
      return isSegmentPrefix(left, right) || isSegmentPrefix(right, left);
    }),
  );
}

function byPriority(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(
    (a, b) =>
      b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

function activeWorkerCount(sessions: SchedulerState["sessions"]): number {
  return sessions.filter(
    (session) =>
      session.status === "running" && (session.role === "worker" || session.role === "fixer"),
  ).length;
}

function activeResumeAt({ backoffResumeAt }: RuntimeFlags, now: Date): string | null {
  return backoffResumeAt !== null && Date.parse(backoffResumeAt) > now.getTime()
    ? backoffResumeAt
    : null;
}

function pickReady({ tasks, starting }: SchedulerState, limit: number): Task[] {
  const statusById = new Map(tasks.map((task) => [task.id, task.status]));
  const startingIds = new Set(starting);
  const occupied = tasks
    .filter((task) => occupyingStatuses.has(task.status) || startingIds.has(task.id))
    .map((task) => task.touches);
  const picked: Task[] = [];
  for (const task of byPriority(tasks)) {
    if (picked.length >= limit) break;
    if (task.status !== "pending" || task.held || startingIds.has(task.id)) continue;
    if (!task.deps.every((dep) => statusById.get(dep) === "done")) continue;
    if (occupied.some((touches) => touchesOverlap(task.touches, touches))) continue;
    picked.push(task);
    occupied.push(task.touches);
  }
  return picked;
}

export function selectReady(state: SchedulerState): Task[] {
  const { flags, now } = state;
  if (flags.paused || flags.authRequired || activeResumeAt(flags, now) !== null) return [];
  const busy = activeWorkerCount(state.sessions) + state.starting.length;
  return pickReady(state, state.maxWorkers - busy);
}

const emptyCounts: Summary["counts"] = {
  pending: 0,
  running: 0,
  checking: 0,
  review: 0,
  rebasing: 0,
  done: 0,
  blocked: 0,
};

export function summarize(state: SchedulerState): Summary {
  const counts = { ...emptyCounts };
  for (const task of state.tasks) counts[task.status] += 1;
  return {
    counts,
    activeWorkers: activeWorkerCount(state.sessions),
    maxWorkers: state.maxWorkers,
    upNext: pickReady(state, Infinity).map((task) => task.id),
    blocked: byPriority(state.tasks)
      .filter((task) => task.status === "blocked")
      .map((task) => task.id),
    paused: state.flags.paused,
    authRequired: state.flags.authRequired,
    resumeAt: activeResumeAt(state.flags, state.now),
  };
}

const minute = 60_000;
const firstBackoffMs = 5 * minute;
const maxBackoffMs = 60 * minute;

function backoffDelayMs(consecutiveLimits: number): number {
  return Math.min(firstBackoffMs * 2 ** (consecutiveLimits - 1), maxBackoffMs);
}

export interface SchedulerOptions {
  db: Db;
  bus: EventBus;
  clock: Clock;
  maxWorkers: () => number;
  startTask: (task: Task) => Promise<void>;
  onError: (error: unknown) => void;
  intervalMs?: number;
}

export interface Scheduler {
  start(): void;
  stop(): void;
  wake(): void;
  reportUsageLimit(resetAt?: Date): Date;
  reportSuccess(): void;
  summary(): Summary;
}

const wakingEvents: ReadonlySet<BusEventType> = new Set([
  "task.updated",
  "session.ended",
  "scheduler.updated",
  "auth.updated",
  "config.updated",
]);

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { db, bus, clock, startTask, onError, intervalMs = 3_000 } = options;
  const scope: SchedulerScope = {
    db,
    emit: (event) => {
      bus.emit(event);
    },
  };
  let interval: ReturnType<typeof setInterval> | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  const starting = new Set<string>();
  let consecutiveLimits = 0;

  function readState(): SchedulerState {
    return {
      tasks: db.tasks.list(),
      sessions: db.sessions.listRunning(),
      flags: db.flags.get(),
      starting: [...starting],
      maxWorkers: options.maxWorkers(),
      now: clock.now(),
    };
  }

  function launch(task: Task): void {
    starting.add(task.id);
    Promise.resolve()
      .then(() => startTask(task))
      .catch(onError)
      .finally(() => {
        starting.delete(task.id);
      });
  }

  function tick(): void {
    try {
      for (const task of selectReady(readState())) launch(task);
    } catch (error) {
      onError(error);
    }
  }

  function wake(): void {
    if (interval === null || wakeTimer !== null) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      tick();
    }, 0);
  }

  function clearTimer(timer: ReturnType<typeof setTimeout> | null): null {
    if (timer !== null) clearTimeout(timer);
    return null;
  }

  function armResume(resumeAt: Date): void {
    resumeTimer = clearTimer(resumeTimer);
    resumeTimer = setTimeout(
      () => {
        resumeTimer = null;
        try {
          setBackoff(scope, null);
        } catch (error) {
          onError(error);
        }
      },
      Math.max(resumeAt.getTime() - clock.now().getTime(), 0),
    );
  }

  return {
    start() {
      if (interval !== null) return;
      interval = setInterval(tick, intervalMs);
      unsubscribe = bus.subscribe((event) => {
        if (wakingEvents.has(event.type)) wake();
      });
      const { backoffResumeAt } = db.flags.get();
      if (backoffResumeAt !== null) armResume(new Date(backoffResumeAt));
      wake();
    },

    stop() {
      if (interval !== null) clearInterval(interval);
      interval = null;
      wakeTimer = clearTimer(wakeTimer);
      resumeTimer = clearTimer(resumeTimer);
      unsubscribe?.();
      unsubscribe = null;
    },

    wake,

    reportUsageLimit(resetAt) {
      const now = clock.now();
      const current = activeResumeAt(db.flags.get(), now);
      if (current !== null) return new Date(current);
      consecutiveLimits += 1;
      const resumeAt =
        resetAt !== undefined && resetAt.getTime() > now.getTime()
          ? resetAt
          : new Date(now.getTime() + backoffDelayMs(consecutiveLimits));
      setBackoff(scope, resumeAt);
      if (interval !== null) armResume(resumeAt);
      return resumeAt;
    },

    reportSuccess() {
      consecutiveLimits = 0;
    },

    summary: () => summarize(readState()),
  };
}
