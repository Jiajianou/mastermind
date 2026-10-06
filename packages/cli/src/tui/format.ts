import { planLabel } from "@mastermind/core/contracts";
import { clockTime } from "@mastermind/core/status";
import type { EventLine, StatusHeader, StatusSnapshot } from "@mastermind/core/status";
import type { LiveCounts } from "../messages.js";

const minuteMs = 60_000;

export function elapsed(startedAt: string, now: Date): string {
  const ms = Math.max(now.getTime() - Date.parse(startedAt), 0);
  if (ms < minuteMs) return `${String(Math.floor(ms / 1_000))}s`;
  const minutes = Math.floor(ms / minuteMs);
  if (minutes < 60) return `${String(minutes)}m`;
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function sessionRole(role: string, attempt: number | null): string {
  return attempt === null || attempt <= 1 ? role : `${role}#${String(attempt)}`;
}

export function eventLineText(line: EventLine): string {
  return `${clockTime(new Date(line.ts))}  ${line.label.padEnd(14)} ${line.text}`;
}

export function headerTitle(header: StatusHeader): string {
  const commit = header.mainCommit === null ? "" : ` @ ${header.mainCommit}`;
  return `mastermind · ${header.repoName} · ${header.mainBranch}${commit}`;
}

export function accountText(header: StatusHeader): string {
  return `${header.email ?? "signed in"} · ${planLabel(header.plan)}`;
}

export function liveCounts(snapshot: StatusSnapshot): LiveCounts {
  return { sessions: snapshot.running.length, checks: snapshot.runningChecks };
}
