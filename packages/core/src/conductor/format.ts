export function hourMinute(date: Date): string {
  return [date.getHours(), date.getMinutes()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

export function listWithin(items: readonly string[], maxLength: number): string {
  const shown: string[] = [];
  let length = 0;
  for (const item of items) {
    length += item.length + 2;
    if (shown.length > 0 && length > maxLength) break;
    shown.push(item);
  }
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${String(rest)} more` : shown.join(", ");
}

export function joinPhrases(phrases: readonly string[]): string {
  const [first, ...rest] = phrases;
  if (first === undefined) return "";
  const later = rest.map((phrase) => `${phrase.charAt(0).toLowerCase()}${phrase.slice(1)}`);
  const last = later.pop();
  return last === undefined ? first : `${[first, ...later].join(", ")} and ${last}`;
}
