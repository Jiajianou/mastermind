import type { Task, TaskStatus } from "./tasks.js";

export type QueueWait =
  | { kind: "held" }
  | { kind: "deps"; deps: { id: string; status: TaskStatus | null }[] }
  | { kind: "touches"; taskId: string };

export interface QueueEntry {
  task: Task;
  wait: QueueWait | null;
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

export function byPriority(tasks: readonly Task[]): Task[] {
  return [...tasks].sort(
    (a, b) =>
      b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

// Every pending task in start order, each either ready (no wait) or with what it waits on. A ready task claims its
// touches, so a lower-priority task sharing paths with it waits on it, exactly as the scheduler would start them.
export function taskQueue(tasks: readonly Task[], starting: readonly string[] = []): QueueEntry[] {
  const statusById = new Map(tasks.map((task) => [task.id, task.status]));
  const startingIds = new Set(starting);
  const occupied = tasks
    .filter((task) => occupyingStatuses.has(task.status) || startingIds.has(task.id))
    .map(({ id, touches }) => ({ id, touches }));
  const queue: QueueEntry[] = [];
  for (const task of byPriority(tasks)) {
    if (task.status !== "pending" || startingIds.has(task.id)) continue;
    const wait = waitOf(task, statusById, occupied);
    queue.push({ task, wait });
    if (wait === null) occupied.push({ id: task.id, touches: task.touches });
  }
  return queue;
}

function waitOf(
  task: Task,
  statusById: ReadonlyMap<string, TaskStatus>,
  occupied: readonly { id: string; touches: readonly string[] }[],
): QueueWait | null {
  if (task.held) return { kind: "held" };
  const unmet = task.deps
    .map((id) => ({ id, status: statusById.get(id) ?? null }))
    .filter(({ status }) => status !== "done");
  if (unmet.length > 0) return { kind: "deps", deps: unmet };
  const clash = occupied.find(({ touches }) => touchesOverlap(task.touches, touches));
  return clash === undefined ? null : { kind: "touches", taskId: clash.id };
}
