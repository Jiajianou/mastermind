import type { Comment, Finding, ReviewNotes } from "@mastermind/core/contracts";
import { reviewTextMaxLength } from "@mastermind/core/contracts";

export interface RoundNotes {
  comments: Comment[];
  findings: Finding[];
}

export const noNotes: RoundNotes = { comments: [], findings: [] };

export function roundNotes(notes: ReviewNotes | undefined, round: number): RoundNotes {
  if (notes === undefined) return noNotes;
  return {
    comments: notes.comments.filter((comment) => comment.round === round),
    findings: notes.findings.filter((finding) => finding.round === round && !finding.dismissed),
  };
}

export function noteCounts({ comments, findings }: RoundNotes): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { file } of [...comments, ...findings]) counts[file] = (counts[file] ?? 0) + 1;
  return counts;
}

export const fileNotes = ({ comments, findings }: RoundNotes, path: string): RoundNotes => ({
  comments: comments.filter((comment) => comment.file === path),
  findings: findings.filter((finding) => finding.file === path),
});

export const maxExcerptLines = 40;

export function commentExcerpt(text: string): string {
  return text.split("\n").slice(0, maxExcerptLines).join("\n").slice(0, reviewTextMaxLength);
}

export const lineRange = (start: number, end: number): string =>
  start === end ? `line ${String(start)}` : `lines ${String(start)}–${String(end)}`;

export const count = (amount: number, noun: string): string =>
  `${String(amount)} ${noun}${amount === 1 ? "" : "s"}`;
