export interface LiveCounts {
  sessions: number;
  checks: number;
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}

export function footerHint(paused: boolean): string {
  return `p ${paused ? "resume" : "pause"} · o open · c copy link · Ctrl+C twice to quit (stops all sessions)`;
}

export function armedWarning({ sessions, checks }: LiveCounts): string {
  return `Press Ctrl+C again to quit. This kills ${count(sessions, "session")} and ${count(checks, "check")} immediately. Worktrees are kept.`;
}

export function killSummary({ sessions, checks }: LiveCounts): string {
  return [
    `Stopped mastermind. Killed ${count(sessions, "session")}, ${count(checks, "check")}.`,
    "Worktrees kept. Unfinished tasks resume on the next `mastermind .`",
  ].join("\n");
}

export const linkPlaceholder =
  "Web app → not served yet (the web app arrives in a later milestone)";

export const noLinkNotice = "There is no web app link yet.";
