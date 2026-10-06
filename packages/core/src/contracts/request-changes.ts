import type { Check, CheckKind } from "./checks.js";
import type { Comment, Finding } from "./review.js";

export type CommentNote = Pick<Comment, "file" | "lineStart" | "lineEnd" | "excerpt" | "text">;
export type FindingNote = Pick<Finding, "file" | "line" | "severity" | "text">;

export interface FailingTest {
  check: Pick<Check, "kind" | "summary">;
  log: string;
}

export interface ChangeRequestParts {
  instruction: string;
  comments: readonly CommentNote[];
  findings: readonly FindingNote[];
  failingTest: FailingTest | null;
}

export const failingTestLogLines = 60;

const checkTitles: Record<CheckKind, string> = {
  setup: "Setup",
  build: "Build",
  acceptance: "Acceptance",
  rebase: "Rebase onto main",
  suite: "Test suite",
  reviewer: "Reviewer",
};

// The fence is longer than any backtick run inside, so an excerpt that itself contains a fence can't end the block.
function fenced(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map(([run]) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${text}\n${fence}`;
}

const lines = ({ lineStart, lineEnd }: CommentNote): string =>
  lineStart === lineEnd
    ? `line ${String(lineStart)}`
    : `lines ${String(lineStart)}–${String(lineEnd)}`;

function byLocation(a: CommentNote, b: CommentNote): number {
  return a.file === b.file
    ? a.lineStart - b.lineStart || a.lineEnd - b.lineEnd
    : a.file.localeCompare(b.file);
}

function commentSection(comments: readonly CommentNote[]): string[] {
  if (comments.length === 0) return [];
  return [
    "## Comments on the code",
    ...[...comments].sort(byLocation).map((comment) => {
      const excerpt = comment.excerpt.replace(/\n+$/, "");
      const heading = `### ${comment.file}, ${lines(comment)}`;
      const quoted = excerpt === "" ? [] : [fenced(excerpt)];
      return [heading, ...quoted, comment.text.trim()].join("\n\n");
    }),
  ];
}

const findingLine = (finding: FindingNote): string =>
  `- ${finding.severity} · ${finding.file}${finding.line === null ? "" : `:${String(finding.line)}`}: ${finding.text.trim()}`;

function findingSection(findings: readonly FindingNote[]): string[] {
  if (findings.length === 0) return [];
  return ["## Reviewer findings", findings.map(findingLine).join("\n")];
}

function logTail(log: string): string {
  const all = log.replace(/\n+$/, "").split("\n");
  return all.slice(-failingTestLogLines).join("\n");
}

function failingTestSection(failingTest: FailingTest | null): string[] {
  if (failingTest === null) return [];
  const { check, log } = failingTest;
  const summary = check.summary === null ? "" : `: ${check.summary}`;
  const tail = logTail(log);
  return [
    `## Failing check: ${checkTitles[check.kind]}`,
    `It failed${summary}. The last lines of its log:`,
    fenced(tail === "" ? "(no output)" : tail),
  ];
}

export function buildChangeRequest(parts: ChangeRequestParts): string {
  const instruction = parts.instruction.trim();
  return [
    "The owner reviewed this work and asks for the changes below.",
    ...(instruction === "" ? [] : [instruction]),
    ...commentSection(parts.comments),
    ...findingSection(parts.findings),
    ...failingTestSection(parts.failingTest),
    "Make these changes, keep the rest of the work as it is, run the acceptance command until it passes, and commit. Then update `.mastermind-result.md`.",
  ].join("\n\n");
}
