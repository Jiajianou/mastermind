import { GitError } from "../git/index.js";
import type { Git } from "../git/index.js";

export interface FastForwardRequest {
  repoRoot: string;
  mainBranch: string;
  subject: string;
  from: string;
  to: string;
}

export type FastForward = { kind: "moved"; current: string } | { kind: "done" };

const mainRef = (mainBranch: string): string => `refs/heads/${mainBranch}`;

export async function readMain(git: Git, repoRoot: string, mainBranch: string): Promise<string> {
  return (await git.run(repoRoot, ["rev-parse", "--verify", mainRef(mainBranch)])).trim();
}

// Any worktree of the owner's repo counts, not only the main one: moving a branch checked out anywhere would leave
// that checkout's files behind its HEAD.
export async function mainCheckedOut(
  git: Git,
  repoRoot: string,
  mainBranch: string,
): Promise<boolean> {
  const output = await git.run(repoRoot, ["worktree", "list", "--porcelain"]);
  return output.split("\n").includes(`branch ${mainRef(mainBranch)}`);
}

export async function fastForwardMain(git: Git, request: FastForwardRequest): Promise<FastForward> {
  const { repoRoot, mainBranch, from, to } = request;
  const reason = `mastermind: rebase ${request.subject} onto ${mainBranch}`;
  try {
    await git.run(repoRoot, ["update-ref", "-m", reason, mainRef(mainBranch), to, from]);
    return { kind: "done" };
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    const current = await readMain(git, repoRoot, mainBranch);
    if (current !== from) return { kind: "moved", current };
    throw error;
  }
}

export async function deleteRef(git: Git, repoRoot: string, ref: string): Promise<void> {
  await git.run(repoRoot, ["update-ref", "-d", ref]);
}
