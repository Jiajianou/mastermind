import { taskQueue } from "@mastermind/core/contracts";
import type { QueueWait, Task } from "@mastermind/core/contracts";
import type { SchedulerState } from "../store/state.js";

export interface WaitingTask {
  task: Task;
  reason: string;
}

export interface UpNext {
  ready: Task[];
  waiting: WaitingTask[];
}

function waitReason(wait: QueueWait): string {
  switch (wait.kind) {
    case "held":
      return "Held";
    case "deps":
      return `Waits on ${wait.deps
        .map(({ id, status }) => `${id} (${status ?? "missing"})`)
        .join(", ")}`;
    case "touches":
      return `Shares paths with ${wait.taskId}`;
  }
}

export function upNext(tasks: readonly Task[]): UpNext {
  const ready: Task[] = [];
  const waiting: WaitingTask[] = [];
  for (const { task, wait } of taskQueue(tasks)) {
    if (wait === null) ready.push(task);
    else waiting.push({ task, reason: waitReason(wait) });
  }
  return { ready, waiting };
}

export function schedulerHold(scheduler: SchedulerState): string | null {
  if (scheduler.authRequired) return "Nothing starts until you sign in again.";
  if (scheduler.resumeAt !== null) return "Nothing starts until the usage limit resets.";
  if (scheduler.paused) return "Paused. Nothing starts until you resume.";
  return null;
}
