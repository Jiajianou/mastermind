export const clockTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function localResumeTime(iso: string, now: Date = new Date()): string {
  const time = new Date(iso);
  const clock = clockTime(iso);
  if (time.toDateString() === now.toDateString()) return clock;
  return `${time.toLocaleDateString([], { weekday: "short" })} ${clock}`;
}
