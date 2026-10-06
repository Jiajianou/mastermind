export function localResumeTime(iso: string, now: Date = new Date()): string {
  const time = new Date(iso);
  const clock = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (time.toDateString() === now.toDateString()) return clock;
  return `${time.toLocaleDateString([], { weekday: "short" })} ${clock}`;
}
