import type { CommandKind, ProjectDetection } from "../contracts/index.js";
import { commandKindSchema, errorMessage, plural } from "../contracts/index.js";
import type { PruneReport } from "../logs.js";
import type { RecoveryFailure, RecoveryReport } from "../recovery.js";

function describeFailure(failure: RecoveryFailure): string {
  return failure.kind === "reap"
    ? `Could not stop session ${String(failure.sessionId)} from the previous run: ${errorMessage(failure.error)}`
    : `Could not save the work in task ${failure.taskId}: ${errorMessage(failure.error)}`;
}

export function describeRecovery(report: RecoveryReport): string[] {
  const lines: string[] = [];
  if (report.reaped.length > 0)
    lines.push(
      `Stopped ${plural(report.reaped.length, "leftover session")} from the previous run.`,
    );
  if (report.saved.length > 0)
    lines.push(
      `Saved uncommitted work as WIP commits in ${report.saved.map(({ taskId }) => taskId).join(", ")}.`,
    );
  if (report.requeued.length > 0) {
    const tasks = report.requeued.map(({ taskId, resumeSession }) =>
      resumeSession === null ? taskId : `${taskId} (resumes its session)`,
    );
    lines.push(`Requeued ${plural(tasks.length, "interrupted task")}: ${tasks.join(", ")}.`);
  }
  return [...lines, ...report.failures.map(describeFailure)];
}

function commandLabel(kind: CommandKind, detection: ProjectDetection): string | null {
  const detected = detection.commands[kind];
  return detected === null ? null : `${kind} \`${detected.command}\``;
}

export function describeLogPruning({ removed, failed }: PruneReport, retention: string): string[] {
  const lines: string[] = [];
  if (removed.length > 0)
    lines.push(`Removed ${plural(removed.length, "log file")} older than ${retention}.`);
  const [first] = failed;
  if (first !== undefined)
    lines.push(
      `Could not remove ${plural(failed.length, "log file")} older than ${retention}, such as ${first.path}: ${errorMessage(first.error)}`,
    );
  return lines;
}

export function describeFirstRun(detection: ProjectDetection): string[] {
  const found = commandKindSchema.options.flatMap((kind) => commandLabel(kind, detection) ?? []);
  const commands =
    found.length === 0
      ? "No setup, build or test commands were detected; the chat will ask for them."
      : `Detected ${found.join(", ")}; the chat will ask you to confirm them.`;
  return ["First run: wrote .mastermind/config.yaml.", commands, ...detection.warnings];
}
