import { taskStatusSchema } from "@mastermind/core/contracts";
import type { ApiSummary, Session, SessionEvent, Task, TaskView } from "@mastermind/core/contracts";
import { clockTime, sessionEndings } from "@mastermind/core/status";
import { elapsed, sessionRole } from "../tui/format.js";

const listOrNone = (items: readonly string[]): string =>
  items.length === 0 ? "none" : items.join(", ");

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows.reduce<number[]>(
    (max, row) => row.map((cell, column) => Math.max(cell.length, max[column] ?? 0)),
    [],
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0),
        )
        .join("  "),
    )
    .join("\n");
}

function countsText(counts: ApiSummary["counts"]): string {
  const parts = taskStatusSchema.options.flatMap((status) => {
    const count = counts[status];
    return count > 0 ? [`${String(count)} ${status}`] : [];
  });
  return parts.length === 0 ? "none yet" : parts.join(" · ");
}

function schedulerText(summary: ApiSummary): string {
  if (summary.authRequired) return "waiting for the Claude sign-in";
  if (summary.paused) return "paused";
  if (summary.resumeAt !== null)
    return `usage limit, resumes at ${clockTime(new Date(summary.resumeAt))}`;
  return "running";
}

function runningText(sessions: readonly Session[], now: Date): string {
  const workers = sessions.filter((session) => session.role !== "conductor");
  return listOrNone(
    workers.map(
      (session) =>
        `${session.taskId ?? "-"} (${sessionRole(session.role, session.attempt)}, ${elapsed(session.startedAt, now)})`,
    ),
  );
}

export function summaryText(summary: ApiSummary, now: Date): string {
  const rows = [
    ["Tasks", countsText(summary.counts)],
    ["Workers", `${String(summary.activeWorkers)} of ${String(summary.maxWorkers)} busy`],
    ["Running", runningText(summary.activeSessions, now)],
    ["Up next", listOrNone(summary.upNext)],
    ["Blocked", listOrNone(summary.blocked)],
    ...(summary.rebaseQueue.length === 0 ? [] : [["Rebasing", summary.rebaseQueue.join(", ")]]),
    ["Scheduler", schedulerText(summary)],
  ];
  return `${table(rows)}\n`;
}

export function taskStateText(task: Pick<Task, "status" | "held">): string {
  return task.held ? `${task.status} (held)` : task.status;
}

export function tasksText(tasks: readonly TaskView[]): string {
  if (tasks.length === 0) return "No tasks yet.\n";
  const rows = tasks.map((task) => [
    task.id,
    taskStateText(task),
    String(task.priority),
    task.deps.length === 0 ? "-" : task.deps.join(", "),
    task.title,
  ]);
  return `${table([["ID", "STATUS", "PRIORITY", "DEPS", "TITLE"], ...rows])}\n`;
}

export function sessionEventText(session: Session | undefined, event: SessionEvent): string {
  const who = session === undefined ? `session ${String(event.sessionId)}` : sessionName(session);
  return `${clockTime(new Date(event.ts))}  ${who.padEnd(10)} ${event.type.padEnd(7)}${event.summary}\n`;
}

export function sessionEndText(session: Session): string | null {
  if (session.status === "running") return null;
  const at = clockTime(new Date(session.endedAt ?? session.startedAt));
  return `${at}  ${sessionName(session).padEnd(10)} ${"ended".padEnd(7)}${sessionEndings[session.status]}\n`;
}

function sessionName(session: Session): string {
  return sessionRole(session.role, session.attempt);
}
