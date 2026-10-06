import type { TaskStatus } from "@mastermind/core/contracts";
import { taskStatusTone, taskStatusWord } from "./board.js";

export function StatusWord({ status }: { status: TaskStatus }) {
  return (
    <span className={`status-word tone-${taskStatusTone(status)}`}>{taskStatusWord(status)}</span>
  );
}
