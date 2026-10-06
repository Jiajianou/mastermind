import type { Check, Task } from "../contracts/index.js";

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

export function workerTaskPrompt(task: Task, setup: Check | null): string {
  return [
    `# Task ${task.id}: ${task.title}`,
    "## Goal",
    task.goal.trim(),
    "## Acceptance command",
    "This command must exit 0 from the root of the clone:",
    "```sh\n" + task.acceptance.trim() + "\n```",
    "## Paths you may touch",
    pathList(task.touches),
    ...setupNote(setup),
  ].join("\n\n");
}
