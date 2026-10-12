import { z } from "zod";

export type DiffLineKind = "same" | "added" | "removed";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

const maxTableCells = 250_000;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  return text.endsWith("\n") ? lines.slice(0, -1) : lines;
}

const tagged = (kind: DiffLineKind, lines: readonly string[]): DiffLine[] =>
  lines.map((text) => ({ kind, text }));

function commonLengths(before: readonly string[], after: readonly string[]): number[][] {
  const table = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--) {
    const row = table[i] ?? [];
    const below = table[i + 1] ?? [];
    for (let j = after.length - 1; j >= 0; j--)
      row[j] =
        before[i] === after[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
  }
  return table;
}

function middleDiff(before: readonly string[], after: readonly string[]): DiffLine[] {
  if (before.length * after.length > maxTableCells)
    return [...tagged("removed", before), ...tagged("added", after)];
  const table = commonLengths(before, after);
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    const left = before[i] ?? "";
    const right = after[j] ?? "";
    if (left === right) {
      lines.push({ kind: "same", text: left });
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      lines.push({ kind: "removed", text: left });
      i++;
    } else {
      lines.push({ kind: "added", text: right });
      j++;
    }
  }
  return [...lines, ...tagged("removed", before.slice(i)), ...tagged("added", after.slice(j))];
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const old = splitLines(before);
  const next = splitLines(after);
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let oldEnd = old.length;
  let nextEnd = next.length;
  while (oldEnd > start && nextEnd > start && old[oldEnd - 1] === next[nextEnd - 1]) {
    oldEnd--;
    nextEnd--;
  }
  return [
    ...tagged("same", old.slice(0, start)),
    ...middleDiff(old.slice(start, oldEnd), next.slice(start, nextEnd)),
    ...tagged("same", old.slice(oldEnd)),
  ];
}

export function diffCounts(lines: readonly DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter((line) => line.kind === "added").length,
    removed: lines.filter((line) => line.kind === "removed").length,
  };
}

export const patchHunkSchema = z.object({
  oldStart: z.int(),
  oldLines: z.int(),
  newStart: z.int(),
  newLines: z.int(),
  lines: z.array(z.string()),
});
export type PatchHunk = z.infer<typeof patchHunkSchema>;

export const editResultSchema = z.object({ structuredPatch: z.array(patchHunkSchema) });

export interface NumberedDiffLine extends DiffLine {
  number: number | null;
}

export const hunkGap: NumberedDiffLine = { kind: "same", text: "…", number: null };

function hunkLines(hunk: PatchHunk): NumberedDiffLine[] {
  let oldNumber = hunk.oldStart;
  let newNumber = hunk.newStart;
  return hunk.lines.flatMap((line): NumberedDiffLine[] => {
    const text = line.slice(1);
    switch (line[0]) {
      case "-":
        return [{ kind: "removed", text, number: oldNumber++ }];
      case "+":
        return [{ kind: "added", text, number: newNumber++ }];
      case " ":
        oldNumber++;
        return [{ kind: "same", text, number: newNumber++ }];
      default:
        return [];
    }
  });
}

export function patchLines(hunks: readonly PatchHunk[]): NumberedDiffLine[] {
  return hunks.flatMap((hunk, index) => [...(index === 0 ? [] : [hunkGap]), ...hunkLines(hunk)]);
}
