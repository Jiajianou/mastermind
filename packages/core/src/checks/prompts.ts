import { fenced } from "../contracts/index.js";
import type { Check, Finding, Task } from "../contracts/index.js";
import { taskBrief } from "../sessions/prompts.js";

export interface FailedCheck {
  check: Check;
  logTail: string;
}

export interface Conflict {
  upstream: string;
  mainBranch: string;
  logTail: string;
}

const checkNames: Record<Check["kind"], string> = {
  setup: "setup",
  build: "build",
  acceptance: "acceptance",
  rebase: "rebase",
  suite: "test suite",
  reviewer: "review",
};

export const checkName = (check: Pick<Check, "kind">): string => checkNames[check.kind];

function fixerPrompt(task: Task, problem: string[], instruction: string): string {
  return [`# Fix task ${task.id}: ${task.title}`, ...problem, instruction, ...taskBrief(task)].join(
    "\n\n",
  );
}

export function checkFailurePrompt(task: Task, { check, logTail }: FailedCheck): string {
  const where = check.logPath === null ? "" : ` The full log is in ${check.logPath}.`;
  return fixerPrompt(
    task,
    [
      `## The ${checkName(check)} check failed`,
      `Mastermind ran the ${checkName(check)} check in this clone: ${check.summary ?? "it failed"}.${where} Its last lines:`,
      fenced(logTail === "" ? "(no output)" : logTail),
    ],
    "Find and fix the cause, then run the command again until it passes, run the acceptance command, and commit.",
  );
}

const findingLine = (finding: Finding): string =>
  `- ${finding.file}${finding.line === null ? "" : `:${String(finding.line)}`}: ${finding.text}`;

export function findingsPrompt(task: Task, findings: readonly Finding[]): string {
  return fixerPrompt(
    task,
    [
      "## The reviewer found serious problems",
      "A reviewer read the branch and reported:",
      findings.map(findingLine).join("\n"),
    ],
    "Fix each of these, run the acceptance command, and commit.",
  );
}

export function conflictPrompt(task: Task, conflict: Conflict): string {
  return fixerPrompt(
    task,
    [
      "## Rebase conflict",
      `Mastermind fetched the latest ${conflict.mainBranch} into this clone as \`upstream/${conflict.mainBranch}\` (${conflict.upstream.slice(0, 7)}) and tried to rebase this branch onto it, but the rebase stopped with conflicts, so it was aborted. Its output:`,
      fenced(conflict.logTail),
    ],
    `Redo the rebase onto \`upstream/${conflict.mainBranch}\`, resolve every conflict, finish the rebase, then run the acceptance command and commit any further fix.`,
  );
}

export function flakyJudgePrompt(task: Task, { check, logTail }: FailedCheck): string {
  return [
    "An automated check failed. Decide whether the failure is flaky: caused by timing, the network, a busy machine or another outside condition, so that running the same command again on the same code would likely pass. A failure caused by the code (a compile error, a failing assertion, a missing file) is not flaky. When unsure, it is not flaky.",
    `Task: ${task.id}: ${task.title}`,
    `Check: ${checkName(check)}, ${check.summary ?? "failed"}`,
    "The last lines of its log:",
    fenced(logTail === "" ? "(no output)" : logTail),
  ].join("\n\n");
}

export interface ReviewMaterial {
  mainBranch: string;
  upstream: string;
  files: string;
  diff: string;
  diffTruncated: boolean;
}

export function reviewPrompt(task: Task, material: ReviewMaterial): string {
  const cut = material.diffTruncated
    ? "\n\nThe diff was cut short; read the remaining changed files directly."
    : "";
  return [
    `# Review task ${task.id}: ${task.title}`,
    ...taskBrief(task),
    "## Changed files",
    `The branch is rebased onto ${material.mainBranch} (${material.upstream.slice(0, 7)}). Files it changes:`,
    fenced(material.files === "" ? "(none)" : material.files),
    "## Diff",
    "```diff\n" + material.diff + "\n```" + cut,
  ].join("\n\n");
}
