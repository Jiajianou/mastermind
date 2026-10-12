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

// Any worktree of the owner's repo counts, not only the main one: main may be checked out in any of them.
export async function mainCheckout(
  git: Git,
  repoRoot: string,
  mainBranch: string,
): Promise<string | null> {
  const output = await git.run(repoRoot, ["worktree", "list", "--porcelain"]);
  for (const entry of output.split("\n\n")) {
    const lines = entry.split("\n");
    if (!lines.includes(`branch ${mainRef(mainBranch)}`)) continue;
    const path = lines.find((line) => line.startsWith("worktree "));
    if (path !== undefined) return path.slice("worktree ".length);
  }
  return null;
}

export async function mainCheckedOut(
  git: Git,
  repoRoot: string,
  mainBranch: string,
): Promise<boolean> {
  return (await mainCheckout(git, repoRoot, mainBranch)) !== null;
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

// Moving the ref alone would leave the checkout's files behind its HEAD. A fast-forward merge moves both, and git
// refuses, changing nothing, if a local change or an untracked file is in the way.
export async function fastForwardCheckout(
  git: Git,
  checkout: string,
  request: FastForwardRequest,
): Promise<FastForward> {
  const { repoRoot, mainBranch, from, to } = request;
  const before = await readMain(git, repoRoot, mainBranch);
  if (before !== from) return { kind: "moved", current: before };
  try {
    await git.run(checkout, ["merge", "--ff-only", "--quiet", "--no-stat", to]);
    return { kind: "done" };
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    const current = await readMain(git, repoRoot, mainBranch);
    if (current !== from) return { kind: "moved", current };
    throw error;
  }
}
