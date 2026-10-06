import type { FileChange, Task } from "../contracts/index.js";
import { changeList, taskBrief } from "../sessions/prompts.js";

export interface RefineMaterial {
  mainBranch: string;
  baseCommit: string;
  changes: readonly FileChange[];
  request: string;
}

export function refinePrompt(task: Task, material: RefineMaterial): string {
  const base = material.baseCommit.slice(0, 7);
  return [
    `# Task ${task.id}: ${task.title} (round ${String(task.round)})`,
    ...taskBrief(task),
    "## Where the work stands",
    `This clone already holds the work of the earlier rounds on this branch. Compared with ${material.mainBranch} at ${base}, it changes:`,
    changeList(material.changes),
    `Run \`git diff ${base}\` to read it in full.`,
    "## Requested changes",
    material.request,
  ].join("\n\n");
}
