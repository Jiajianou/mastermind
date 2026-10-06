import type { Task, TaskStatus } from "@mastermind/core/contracts";

const working: ReadonlySet<TaskStatus> = new Set(["running", "checking", "rebasing"]);
const needsOwner: ReadonlySet<TaskStatus> = new Set(["review", "blocked"]);

export function progressText(tasks: readonly Task[], pendingDecisions: number): string {
  if (tasks.length === 0 && pendingDecisions === 0) return "No tasks yet";
  const count = (statuses: ReadonlySet<TaskStatus>) =>
    tasks.filter((task) => statuses.has(task.status)).length;
  const done = tasks.filter((task) => task.status === "done").length;
  return [
    `${String(count(working))} working`,
    `${String(count(needsOwner) + pendingDecisions)} needs you`,
    `${String(done)} of ${String(tasks.length)} done`,
  ].join(" · ");
}
