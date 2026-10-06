export interface Mention {
  start: number;
  query: string;
}

const mentionBeforeCaret = /(?:^|\s)@([\w.-]*)$/;
const maxSuggestions = 6;

export function mentionAt(text: string, caret: number): Mention | null {
  const match = mentionBeforeCaret.exec(text.slice(0, caret));
  if (match === null) return null;
  const query = match[1] ?? "";
  return { start: caret - query.length - 1, query };
}

export function suggestTaskIds(taskIds: readonly string[], query: string): string[] {
  const wanted = query.toLowerCase();
  const starting = taskIds.filter((id) => id.startsWith(wanted));
  const containing = taskIds.filter((id) => !id.startsWith(wanted) && id.includes(wanted));
  return [...starting.sort(), ...containing.sort()].slice(0, maxSuggestions);
}

export function completeMention(
  text: string,
  caret: number,
  mention: Mention,
  taskId: string,
): { text: string; caret: number } {
  const inserted = `@${taskId} `;
  return {
    text: `${text.slice(0, mention.start)}${inserted}${text.slice(caret)}`,
    caret: mention.start + inserted.length,
  };
}
