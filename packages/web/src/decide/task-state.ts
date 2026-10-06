import type { Task, TaskStatus } from "@mastermind/core/contracts";

const headlines: Record<TaskStatus, string> = {
  pending: "Waiting to start",
  running: "In progress",
  checking: "Checks running",
  review: "Ready for review",
  rebasing: "Rebasing onto main",
  done: "Rebased onto main",
  blocked: "Blocked",
};

export function decideHeadline({ status, round }: Pick<Task, "status" | "round">): string {
  return status === "pending" || status === "done"
    ? headlines[status]
    : `${headlines[status]} · round ${String(round)}`;
}

export interface Decisions {
  approve: boolean;
  discard: boolean;
  rerun: boolean;
}

export function availableDecisions(status: TaskStatus): Decisions {
  return {
    approve: status === "review",
    discard: status === "review" || status === "blocked",
    rerun: status === "review",
  };
}

export const hasWorkToShow = ({ status, worktree }: Pick<Task, "status" | "worktree">): boolean =>
  worktree !== null && status !== "done";

export function decidePath(taskId: string, file: string | null = null): string {
  const path = `/review/decide/${encodeURIComponent(taskId)}`;
  return file === null ? path : `${path}?${new URLSearchParams({ file }).toString()}`;
}

export function taskReviewPath(taskId: string, status: TaskStatus | undefined): string {
  return status === "review" ? decidePath(taskId) : `/review?task=${encodeURIComponent(taskId)}`;
}
