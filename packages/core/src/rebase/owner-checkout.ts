import type { MainUpstream, OwnerBranch } from "../contracts/index.js";
import { exitedWith, GitError } from "../git/index.js";
import type { Git } from "../git/index.js";

export async function currentBranch(git: Git, repoRoot: string): Promise<string | null> {
  try {
    return (await git.run(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  } catch (error) {
    if (exitedWith(error, 1)) return null;
    throw error;
  }
}

export async function branchTip(git: Git, repoRoot: string, branch: string): Promise<string> {
  return (
    await git.run(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`])
  ).trim();
}

// Untracked files count too: one in the way would make the final `git reset --keep` fail after main had moved.
export async function checkoutIsClean(git: Git, repoRoot: string): Promise<boolean> {
  return (await git.run(repoRoot, ["status", "--porcelain"])).trim() === "";
}

export async function countCommits(git: Git, cwd: string, range: string): Promise<number> {
  return Number((await git.run(cwd, ["rev-list", "--count", range])).trim());
}

// Mastermind never fetches (decision 7), so this compares main with whatever the owner last fetched.
export async function mainUpstream(
  git: Git,
  repoRoot: string,
  mainBranch: string,
): Promise<MainUpstream | null> {
  let name: string;
  try {
    name = (
      await git.run(repoRoot, [
        "rev-parse",
        "--abbrev-ref",
        "--verify",
        "--quiet",
        `${mainBranch}@{upstream}`,
      ])
    ).trim();
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
  if (name === "") return null;
  return { name, ahead: await countCommits(git, repoRoot, `${name}..refs/heads/${mainBranch}`) };
}

export async function readOwnerBranch(
  git: Git,
  repoRoot: string,
  mainBranch: string,
): Promise<Omit<OwnerBranch, "rebase">> {
  const branch = await currentBranch(git, repoRoot);
  const upstream = await mainUpstream(git, repoRoot, mainBranch);
  const view = { branch, mainBranch, onMain: branch === mainBranch, upstream };
  if (branch === null || branch === mainBranch) return { ...view, ahead: 0, behind: 0 };
  const [main, own] = [`refs/heads/${mainBranch}`, `refs/heads/${branch}`];
  return {
    ...view,
    ahead: await countCommits(git, repoRoot, `${main}..${own}`),
    behind: await countCommits(git, repoRoot, `${own}..${main}`),
  };
}
