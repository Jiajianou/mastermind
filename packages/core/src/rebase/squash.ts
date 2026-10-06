import { join } from "node:path";
import { stripAttribution } from "../attribution.js";
import { readOptionalFile } from "../config/index.js";
import type { Task } from "../contracts/index.js";
import { GitError, headCommit, resultFileName } from "../git/index.js";
import type { Git } from "../git/index.js";

export type Squash = { kind: "squashed"; commit: string; subject: string } | { kind: "empty" };

export interface SquashRequest {
  task: Pick<Task, "id" | "title">;
  worktree: string;
  upstream: string;
}

// The task id goes in a "Task id:" line, which git does not read as a trailer, so the message has none at all.
export function squashMessage(task: Pick<Task, "id" | "title">, summary: string | null): string {
  const [firstLine = ""] = stripAttribution(task.title).split("\n");
  const subject = firstLine.trim() === "" ? `Task ${task.id}` : firstLine.trim();
  const body = summary === null ? "" : stripAttribution(summary);
  return [subject, body, `Task id: ${task.id}`].filter((part) => part !== "").join("\n\n");
}

async function nothingStaged(git: Git, worktree: string): Promise<boolean> {
  try {
    await git.run(worktree, ["diff", "--cached", "--quiet"]);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exit.kind === "exited" && error.exit.code === 1)
      return false;
    throw error;
  }
}

// Hooks are off so that nothing in the managed repo can add a trailer to the message mastermind wrote.
export async function squashBranch(git: Git, request: SquashRequest): Promise<Squash> {
  const { task, worktree, upstream } = request;
  const summary = await readOptionalFile(join(worktree, resultFileName));
  const message = squashMessage(task, summary);
  await git.run(worktree, ["reset", "--quiet", "--soft", upstream]);
  if (await nothingStaged(git, worktree)) return { kind: "empty" };
  await git.run(worktree, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "--no-verify",
    "--cleanup=whitespace",
    "--message",
    message,
  ]);
  const [subject = ""] = message.split("\n");
  return { kind: "squashed", commit: await headCommit(git, worktree), subject };
}
