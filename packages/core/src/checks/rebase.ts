import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "../contracts/index.js";
import { fetchMainIntoClone, GitError, upstreamRef } from "../git/index.js";
import type { Git } from "../git/index.js";
import { describeExit, errorMessage, exitedCleanly, startCheck } from "./runner.js";
import type { CheckContext } from "./runner.js";

export interface RebaseRequest {
  taskId: string;
  round: number;
  worktree: string;
  repoRoot: string;
  mainBranch: string;
}

export type RebaseResult =
  | { kind: "on-main"; check: Check; upstream: string }
  | { kind: "conflict"; check: Check; upstream: string };

const rebaseStateDirs = ["rebase-merge", "rebase-apply"];

export const quietGit = ["-c", "core.hooksPath=/dev/null", "-c", "core.editor=true"];

export async function rebaseInProgress(git: Git, worktree: string): Promise<boolean> {
  for (const name of rebaseStateDirs) {
    const path = (await git.run(worktree, ["rev-parse", "--git-path", name])).trim();
    if (existsSync(join(worktree, path))) return true;
  }
  return false;
}

export async function abortRebase(git: Git, worktree: string): Promise<boolean> {
  if (!(await rebaseInProgress(git, worktree))) return false;
  await git.run(worktree, ["rebase", "--abort"]);
  return true;
}

export async function isAncestor(git: Git, worktree: string, commit: string): Promise<boolean> {
  try {
    await git.run(worktree, ["merge-base", "--is-ancestor", commit, "HEAD"]);
    return true;
  } catch (error) {
    if (error instanceof GitError && error.exit.kind === "exited" && error.exit.code === 1)
      return false;
    throw error;
  }
}

export async function conflictedFiles(git: Git, worktree: string): Promise<string[]> {
  const output = await git.run(worktree, ["diff", "--name-only", "--diff-filter=U"]);
  return output.split("\n").filter((line) => line !== "");
}

export async function rebaseOntoMain(
  context: CheckContext & { git: Git },
  request: RebaseRequest,
): Promise<RebaseResult> {
  const { git } = context;
  const { worktree, mainBranch } = request;
  const run = await startCheck(context, {
    taskId: request.taskId,
    round: request.round,
    kind: "rebase",
    cwd: worktree,
  });
  try {
    const upstream = await fetchMainIntoClone(git, {
      repoRoot: request.repoRoot,
      mainBranch,
      clonePath: worktree,
    });
    const short = upstream.slice(0, 7);
    run.note(`Fetched ${mainBranch} as upstream/${mainBranch} at ${upstream}`);
    if (await isAncestor(git, worktree, upstream)) {
      run.note(`The branch already contains upstream/${mainBranch}.`);
      const check = await run.finish(true, `Already on ${mainBranch} (${short})`);
      return { kind: "on-main", check, upstream };
    }
    run.note(`$ git rebase upstream/${mainBranch}`);
    const exit = await run.exec("git", [...quietGit, "rebase", upstreamRef(mainBranch)]);
    if (exitedCleanly(exit)) {
      const check = await run.finish(true, `Rebased onto ${mainBranch} (${short})`);
      return { kind: "on-main", check, upstream };
    }
    const conflicts = await conflictedFiles(git, worktree);
    run.note(`git rebase upstream/${mainBranch} ${describeExit(exit)}`);
    if (conflicts.length > 0) run.note(["Conflicted files:", ...conflicts].join("\n"));
    if (await abortRebase(git, worktree)) run.note("Aborted the rebase.");
    const files = conflicts.length === 0 ? "" : `: ${conflicts.join(", ")}`;
    const check = await run.finish(
      false,
      `Conflict rebasing onto ${mainBranch} (${short})${files}`,
    );
    return { kind: "conflict", check, upstream };
  } catch (error) {
    await run.finish(false, errorMessage(error));
    throw error;
  }
}
