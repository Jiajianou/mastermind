import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { makeTempDir } from "./cleanup.js";

const execFileAsync = promisify(execFile);

export const owner = { name: "Owner", email: "owner@example.com" };

export interface TempRepoOptions {
  mainBranch?: string;
  files?: Record<string, string>;
  branches?: Record<string, Record<string, string>>;
}

export interface TempRepo {
  path: string;
  mainBranch: string;
  git(...args: string[]): Promise<string>;
}

const gitEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}

export async function createTempRepo(options: TempRepoOptions = {}): Promise<TempRepo> {
  const path = await makeTempDir("repo");
  const mainBranch = options.mainBranch ?? "main";
  const git = async (...args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, { cwd: path, env: gitEnv });
    return stdout.trim();
  };

  await git("init", "--quiet", "--initial-branch", mainBranch);
  await git("config", "user.name", owner.name);
  await git("config", "user.email", owner.email);
  await git("config", "commit.gpgsign", "false");
  await writeFiles(path, options.files ?? { "README.md": "# Temp repo\n" });
  await git("add", "--all");
  await git("commit", "--quiet", "--message", "Initial commit");

  for (const [branch, files] of Object.entries(options.branches ?? {})) {
    await git("switch", "--quiet", "--create", branch);
    await writeFiles(path, files);
    await git("add", "--all");
    await git("commit", "--quiet", "--allow-empty", "--message", `Work on ${branch}`);
    await git("switch", "--quiet", mainBranch);
  }

  return { path, mainBranch, git };
}
