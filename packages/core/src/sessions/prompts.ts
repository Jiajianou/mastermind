import { fenced } from "../contracts/index.js";
import type { Check, FileChange, Task } from "../contracts/index.js";
import { withoutFinalStop } from "./summary.js";

export const resumePrompt = "You were interrupted. Check the worktree state and continue.";

function pathList(touches: readonly string[]): string {
  if (touches.length === 0)
    return "No paths were listed. Keep your changes to what the goal needs.";
  return touches.map((path) => `- ${path}`).join("\n");
}

function setupNote(setup: Check | null): string[] {
  if (setup === null || setup.status === "passed") return [];
  return [
    "## Setup failed",
    `Mastermind ran the project's setup command in this clone and it failed: ${setup.summary ?? "no details"}.` +
      (setup.logPath === null ? "" : ` The output is in ${setup.logPath}.`),
  ];
}

export function taskBrief(task: Task): string[] {
  return [
    "## Goal",
    task.goal.trim(),
    "## Acceptance command",
    "This command must exit 0 from the root of the clone:",
    "```sh\n" + task.acceptance.trim() + "\n```",
    "## Paths you may touch",
    pathList(task.touches),
  ];
}

export function workerTaskPrompt(task: Task, setup: Check | null): string {
  return [`# Task ${task.id}: ${task.title}`, ...taskBrief(task), ...setupNote(setup)].join("\n\n");
}

function changeLine({ status, path, oldPath, additions, deletions }: FileChange): string {
  const where = status === "renamed" && oldPath !== null ? `${oldPath} → ${path}` : path;
  const counts =
    additions === null || deletions === null
      ? "binary"
      : `+${String(additions)} −${String(deletions)}`;
  return `- ${status} ${where} (${counts})`;
}

export function changeList(changes: readonly FileChange[]): string {
  return changes.length === 0 ? "(no files changed yet)" : changes.map(changeLine).join("\n");
}

export interface StuckRestartMaterial {
  mainBranch: string;
  baseCommit: string;
  changes: readonly FileChange[];
  diff: string;
  diffTruncated: boolean;
  reason: string;
  suggestion: string;
}

export function stuckRestartPrompt(task: Task, material: StuckRestartMaterial): string {
  const base = material.baseCommit.slice(0, 7);
  return [
    `# Task ${task.id}: ${task.title}`,
    ...taskBrief(task),
    "## Where the work stands",
    `An earlier session worked on this task in this clone and its work is committed. Compared with ${material.mainBranch} at ${base}, it changes:`,
    changeList(material.changes),
    material.diff.trim() === ""
      ? "The diff is empty."
      : fenced(material.diff.trimEnd(), "diff") +
        (material.diffTruncated
          ? `\n\nThe diff was cut short; run \`git diff ${base}\` to read all of it.`
          : ""),
    "## The previous attempt got stuck",
    `The previous attempt got stuck: ${withoutFinalStop(material.reason)}. Try a different approach: ${withoutFinalStop(material.suggestion)}.`,
  ].join("\n\n");
}
