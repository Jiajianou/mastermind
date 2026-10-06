import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isMissingFileError } from "../config/index.js";
import { GitError } from "../git/index.js";
import type { Git } from "../git/index.js";
import { StartupError } from "./errors.js";

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

export async function findRepo(git: Git, path: string): Promise<string> {
  const target = resolve(path);
  if (!(await isDirectory(target)))
    throw new StartupError("not-a-repo", `${target} is not a directory.`);
  try {
    return (await git.run(target, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    throw new StartupError(
      "not-a-repo",
      `${target} is not inside a git repository. Run mastermind in a git repo (or run \`git init\` there first).`,
      { cause: error },
    );
  }
}

export async function currentBranch(git: Git, repoRoot: string): Promise<string | null> {
  const branch = (await git.run(repoRoot, ["branch", "--show-current"])).trim();
  return branch === "" ? null : branch;
}

export async function localBranches(git: Git, repoRoot: string): Promise<string[]> {
  const output = await git.run(repoRoot, [
    "for-each-ref",
    "--format=%(refname:lstrip=2)",
    "refs/heads",
  ]);
  return output.split("\n").filter((branch) => branch !== "");
}
