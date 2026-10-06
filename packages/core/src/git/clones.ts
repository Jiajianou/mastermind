import { appendFile, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { GitError } from "./runner.js";
import type { Git } from "./runner.js";

export interface TaskClone {
  path: string;
  branch: string;
  baseCommit: string;
}

export interface BranchCopyRequest {
  repoRoot: string;
  branch: string;
  commit: string;
  path: string;
}

export interface CloneRequest {
  repoRoot: string;
  mainBranch: string;
  taskId: string;
  path: string;
}

const identityKeys = ["user.name", "user.email"] as const;

export const resultFileName = ".mastermind-result.md";

export const taskBranch = (taskId: string): string => `task/${taskId}`;

export const taskRef = (taskId: string): string => `refs/mastermind/${taskId}`;

export const upstreamRef = (mainBranch: string): string => `refs/remotes/upstream/${mainBranch}`;

export async function headCommit(git: Git, path: string): Promise<string> {
  return (await git.run(path, ["rev-parse", "HEAD"])).trim();
}

async function readConfig(git: Git, cwd: string, key: string): Promise<string | null> {
  try {
    return (await git.run(cwd, ["config", "--get", key])).trim();
  } catch (error) {
    if (error instanceof GitError && error.exit.kind === "exited" && error.exit.code === 1)
      return null;
    throw error;
  }
}

// A clone does not inherit the repo's own .git/config, so an identity set only there is copied across: every
// commit in the clone must carry the owner's identity (decision 18).
async function copyIdentity(git: Git, repoRoot: string, clonePath: string): Promise<void> {
  for (const key of identityKeys) {
    const value = await readConfig(git, repoRoot, key);
    if (value !== null && value !== "") await git.run(clonePath, ["config", key, value]);
  }
}

export async function createTaskClone(git: Git, request: CloneRequest): Promise<TaskClone> {
  const { repoRoot, mainBranch, taskId, path } = request;
  const branch = taskBranch(taskId);
  await mkdir(dirname(path), { recursive: true });
  await git.run(repoRoot, [
    "clone",
    "--quiet",
    "--local",
    "--single-branch",
    "--branch",
    mainBranch,
    "--",
    repoRoot,
    path,
  ]);
  await git.run(path, ["switch", "--quiet", "--create", branch]);
  await git.run(path, ["remote", "remove", "origin"]);
  await copyIdentity(git, repoRoot, path);
  await appendFile(join(path, ".git", "info", "exclude"), `/${resultFileName}\n`);
  return { path, branch, baseCommit: await headCommit(git, path) };
}

// A detached copy of the owner's branch, so that nothing done in it can move the branch itself.
export async function createBranchCopy(git: Git, request: BranchCopyRequest): Promise<void> {
  const { repoRoot, branch, commit, path } = request;
  await mkdir(dirname(path), { recursive: true });
  await git.run(repoRoot, [
    "clone",
    "--quiet",
    "--local",
    "--no-checkout",
    "--single-branch",
    "--branch",
    branch,
    "--",
    repoRoot,
    path,
  ]);
  await git.run(path, ["checkout", "--quiet", "--detach", commit]);
  await git.run(path, ["remote", "remove", "origin"]);
  await copyIdentity(git, repoRoot, path);
  await appendFile(join(path, ".git", "info", "exclude"), `/${resultFileName}\n`);
}

export async function fetchMainIntoClone(
  git: Git,
  { repoRoot, mainBranch, clonePath }: { repoRoot: string; mainBranch: string; clonePath: string },
): Promise<string> {
  const ref = upstreamRef(mainBranch);
  await git.run(clonePath, [
    "fetch",
    "--quiet",
    "--no-write-fetch-head",
    repoRoot,
    `+refs/heads/${mainBranch}:${ref}`,
  ]);
  return (await git.run(clonePath, ["rev-parse", ref])).trim();
}

export async function fetchTaskIntoRepo(
  git: Git,
  { repoRoot, taskId, clonePath }: { repoRoot: string; taskId: string; clonePath: string },
): Promise<string> {
  const ref = taskRef(taskId);
  await git.run(repoRoot, [
    "fetch",
    "--quiet",
    "--no-write-fetch-head",
    clonePath,
    `+refs/heads/${taskBranch(taskId)}:${ref}`,
  ]);
  return (await git.run(repoRoot, ["rev-parse", ref])).trim();
}

export async function fetchHeadIntoRepo(
  git: Git,
  { repoRoot, clonePath, ref }: { repoRoot: string; clonePath: string; ref: string },
): Promise<string> {
  await git.run(repoRoot, ["fetch", "--quiet", "--no-write-fetch-head", clonePath, `+HEAD:${ref}`]);
  return (await git.run(repoRoot, ["rev-parse", ref])).trim();
}

// Hooks are switched off for mastermind's own commits, because a prepare-commit-msg or commit-msg hook in the
// managed repo could add a trailer or refuse a WIP message.
export async function commitLeftovers(
  git: Git,
  clonePath: string,
  message: string,
): Promise<string | null> {
  if ((await git.run(clonePath, ["status", "--porcelain"])).trim() === "") return null;
  await git.run(clonePath, ["add", "--all"]);
  await git.run(clonePath, [
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "--no-verify",
    "--message",
    message,
  ]);
  return headCommit(git, clonePath);
}

export class CloneLocationError extends Error {
  override readonly name = "CloneLocationError";
}

export async function deleteClone(path: string, worktreeDir: string): Promise<void> {
  const fromRoot = relative(resolve(worktreeDir), resolve(path));
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot))
    throw new CloneLocationError(
      `refusing to delete ${path}: it is not a clone inside ${worktreeDir}`,
    );
  await rm(path, { recursive: true, force: true });
}
