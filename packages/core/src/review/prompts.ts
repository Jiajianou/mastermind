import type { FileChange, Task } from "../contracts/index.js";
import { taskBrief } from "../sessions/prompts.js";

export interface RefineMaterial {
  mainBranch: string;
  baseCommit: string;
  changes: readonly FileChange[];
  request: string;
}

function changeLine({ status, path, oldPath, additions, deletions }: FileChange): string {
  const where = status === "renamed" && oldPath !== null ? `${oldPath} → ${path}` : path;
  const counts =
    additions === null || deletions === null
      ? "binary"
      : `+${String(additions)} −${String(deletions)}`;
  return `- ${status} ${where} (${counts})`;
}

export function refinePrompt(task: Task, material: RefineMaterial): string {
  const base = material.baseCommit.slice(0, 7);
  const files =
    material.changes.length === 0
      ? "(no files changed yet)"
      : material.changes.map(changeLine).join("\n");
  return [
    `# Task ${task.id}: ${task.title} (round ${String(task.round)})`,
    ...taskBrief(task),
    "## Where the work stands",
    `This clone already holds the work of the earlier rounds on this branch. Compared with ${material.mainBranch} at ${base}, it changes:`,
    files,
    `Run \`git diff ${base}\` to read it in full.`,
    "## Requested changes",
    material.request,
  ].join("\n\n");
}
