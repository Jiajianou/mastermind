import type { TaskStatus } from "../contracts/index.js";
import { IllegalTransitionError } from "./errors.js";

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ["running"],
  running: ["checking", "pending", "blocked"],
  checking: ["running", "review", "rebasing", "blocked"],
  review: ["running", "checking", "rebasing", "pending"],
  rebasing: ["done", "running", "blocked"],
  done: [],
  blocked: ["pending"],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(taskId: string, from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(taskId, from, to);
}
