import { plural } from "@mastermind/core/contracts";

export interface LiveCounts {
  sessions: number;
  checks: number;
}

export function footerHint(paused: boolean): string {
  return `p ${paused ? "resume" : "pause"} · o open · c copy link · Ctrl+C twice to quit (stops all sessions)`;
}

export function armedWarning({ sessions, checks }: LiveCounts): string {
  return `Press Ctrl+C again to quit. This kills ${plural(sessions, "session")} and ${plural(checks, "check")} immediately. Worktrees are kept.`;
}

export function killSummary({ sessions, checks }: LiveCounts): string {
  return [
    `Stopped mastermind. Killed ${plural(sessions, "session")}, ${plural(checks, "check")}.`,
    "Worktrees kept. Unfinished tasks resume on the next `mastermind .`",
  ].join("\n");
}
