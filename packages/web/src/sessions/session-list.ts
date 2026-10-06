import type { Check, Rebase, Session, SessionStatus } from "@mastermind/core/contracts";
import { capitalized } from "@mastermind/core/contracts";

const statusWords: Record<SessionStatus, string> = {
  running: "Running",
  succeeded: "Finished",
  failed: "Failed",
  stopped: "Stopped",
  killed: "Killed",
  rate_limited: "Usage limit",
  auth_failed: "Sign-in expired",
};

export const sessionStatusWord = (status: SessionStatus): string => statusWords[status];

export interface SessionGroups {
  active: Session[];
  finishedToday: Session[];
}

function isWorkSession(session: Session): boolean {
  return session.role !== "conductor";
}

export function activeSessions<Entry extends Session>(sessions: readonly Entry[]): Entry[] {
  return sessions
    .filter((session) => isWorkSession(session) && session.status === "running")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id - b.id);
}

export function groupSessions(sessions: readonly Session[], now: Date): SessionGroups {
  const shown = sessions.filter(isWorkSession);
  const today = now.toDateString();
  return {
    active: activeSessions(shown),
    finishedToday: shown
      .filter(
        (session) =>
          session.status !== "running" &&
          session.endedAt !== null &&
          new Date(session.endedAt).toDateString() === today,
      )
      .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? "") || b.id - a.id),
  };
}

export function defaultSessionId({ active, finishedToday }: SessionGroups): number | null {
  return active[0]?.id ?? finishedToday[0]?.id ?? null;
}

export function fixReason(checks: readonly Check[], rebase: Rebase | undefined): string {
  if (rebase?.status === "failed") return "Rebase conflict";
  const failed = checks.filter((check) => check.status === "failed").sort((a, b) => b.id - a.id)[0];
  if (failed === undefined) return "Fixing failed checks";
  const what = `${capitalized(failed.kind)} check failed`;
  return failed.summary === null ? what : `${what}: ${failed.summary}`;
}
