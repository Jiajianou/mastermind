import type { Task, TaskStatus } from "@mastermind/core/contracts";

export interface CountTiles {
  remaining: number;
  running: number;
  done: number;
  blocked: number;
  total: number;
}

const inFlight: ReadonlySet<TaskStatus> = new Set(["running", "checking", "rebasing"]);

export function countTiles(tasks: readonly Task[]): CountTiles {
  const count = (matches: (task: Task) => boolean) => tasks.filter(matches).length;
  return {
    remaining: count((task) => task.status === "pending"),
    running: count((task) => inFlight.has(task.status)),
    done: count((task) => task.status === "done"),
    blocked: count((task) => task.status === "blocked"),
    total: tasks.length,
  };
}

export function rebaseQueue(tasks: readonly Task[]): Task[] {
  return tasks
    .filter((task) => task.status === "rebasing")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

export type NeedsYouItem =
  | { kind: "review"; task: Task }
  | { kind: "blocked"; task: Task }
  | { kind: "decisions"; count: number };

export function needsYou(tasks: readonly Task[], pendingDecisions: number): NeedsYouItem[] {
  const withStatus = (status: "review" | "blocked"): NeedsYouItem[] =>
    tasks
      .filter((task) => task.status === status)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((task) => ({ kind: status, task }));
  const decisions: NeedsYouItem[] =
    pendingDecisions > 0 ? [{ kind: "decisions", count: pendingDecisions }] : [];
  return [...withStatus("review"), ...withStatus("blocked"), ...decisions];
}
