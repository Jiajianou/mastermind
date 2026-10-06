import type { Session } from "@mastermind/core/contracts";
import { activeSessions, defaultSessionId, groupSessions } from "../sessions/session-list.js";

export type TaskSession = Session & { taskId: string };

export const isTaskSession = (session: Session): session is TaskSession =>
  session.taskId !== null && session.role !== "conductor";

export interface ReviewSessions {
  tabs: TaskSession[];
  selected: TaskSession | undefined;
}

function latestOfTask(sessions: readonly TaskSession[], taskId: string): TaskSession | undefined {
  return sessions
    .filter((session) => session.taskId === taskId)
    .sort(
      (a, b) =>
        Number(b.status === "running") - Number(a.status === "running") ||
        b.startedAt.localeCompare(a.startedAt) ||
        b.id - a.id,
    )[0];
}

function chosenSession(
  sessions: readonly TaskSession[],
  request: { session: number | null; task: string | null },
  fallbackId: number | null,
): TaskSession | undefined {
  if (request.session !== null) return sessions.find((session) => session.id === request.session);
  if (request.task !== null) return latestOfTask(sessions, request.task);
  return sessions.find((session) => session.id === fallbackId);
}

export function reviewSessions(
  sessions: readonly Session[],
  request: { session: number | null; task: string | null },
  now: Date,
): ReviewSessions {
  const taskSessions = sessions.filter(isTaskSession);
  const groups = groupSessions(taskSessions, now);
  const active = activeSessions(taskSessions);
  const selected = chosenSession(taskSessions, request, defaultSessionId(groups));
  const tabs = selected === undefined || active.includes(selected) ? active : [...active, selected];
  return { tabs, selected };
}
