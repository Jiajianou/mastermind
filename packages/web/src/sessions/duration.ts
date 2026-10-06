import type { Session } from "@mastermind/core/contracts";

const pad = (value: number) => String(value).padStart(2, "0");

export function durationText(milliseconds: number): string {
  const seconds = Math.max(Math.floor(milliseconds / 1000), 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${String(hours)}h ${pad(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m ${pad(seconds % 60)}s`;
  return `${String(seconds)}s`;
}

export function elapsedText(session: Pick<Session, "startedAt" | "endedAt">, now: Date): string {
  const end = session.endedAt === null ? now.getTime() : Date.parse(session.endedAt);
  return durationText(end - Date.parse(session.startedAt));
}
