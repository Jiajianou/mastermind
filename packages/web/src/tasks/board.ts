import { byPriority } from "@mastermind/core/contracts";
import type { Task, TaskStatus } from "@mastermind/core/contracts";

export type BoardColumn = "remaining" | "running" | "rebasing" | "blocked" | "done";

export interface DepStatus {
  id: string;
  status: TaskStatus | null;
}

export interface BoardCard {
  task: Task;
  unmet: DepStatus[];
}

export type Board = Record<BoardColumn, BoardCard[]>;

const columnOfStatus: Record<TaskStatus, BoardColumn> = {
  pending: "remaining",
  running: "running",
  checking: "running",
  review: "rebasing",
  rebasing: "rebasing",
  blocked: "blocked",
  done: "done",
};

const statusWords: Record<TaskStatus, string> = {
  pending: "Waiting",
  running: "Running",
  checking: "Checking",
  review: "In review",
  rebasing: "Rebasing",
  done: "Done",
  blocked: "Blocked",
};

export const taskStatusWord = (status: TaskStatus): string => statusWords[status];

export type StatusTone = "waiting" | "active" | "attention" | "done";

const statusTones: Record<TaskStatus, StatusTone> = {
  pending: "waiting",
  running: "active",
  checking: "active",
  review: "attention",
  rebasing: "active",
  done: "done",
  blocked: "attention",
};

export const taskStatusTone = (status: TaskStatus): StatusTone => statusTones[status];

export const depStatusWord = ({ status }: DepStatus): string =>
  status === null ? "missing" : taskStatusWord(status).toLowerCase();

export function depStatuses(ids: readonly string[], tasks: readonly Task[]): DepStatus[] {
  const statusById = new Map(tasks.map((task) => [task.id, task.status]));
  return ids.map((id) => ({ id, status: statusById.get(id) ?? null }));
}

export function unmetDeps(task: Task, tasks: readonly Task[]): DepStatus[] {
  if (task.status === "done") return [];
  return depStatuses(task.deps, tasks).filter(({ status }) => status !== "done");
}

export function unblocks(task: Task, tasks: readonly Task[]): DepStatus[] {
  return tasks
    .filter((other) => other.deps.includes(task.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(({ id, status }) => ({ id, status }));
}

export function taskBoard(tasks: readonly Task[]): Board {
  const board: Board = { remaining: [], running: [], rebasing: [], blocked: [], done: [] };
  for (const task of byPriority(tasks))
    board[columnOfStatus[task.status]].push({ task, unmet: unmetDeps(task, tasks) });
  board.done.sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
  return board;
}
