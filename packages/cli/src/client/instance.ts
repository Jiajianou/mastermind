import { projectPaths } from "@mastermind/core/config";
import { createGit } from "@mastermind/core/git";
import { findRunningInstance } from "@mastermind/core/lock";
import { createProcessRegistry } from "@mastermind/core/procs";
import { findRepo, StartupError } from "@mastermind/core/startup";
import { ClientError } from "./errors.js";

export interface Instance {
  origin: string;
  token: string;
}

async function repoRoot(path: string): Promise<string> {
  const git = createGit({ registry: createProcessRegistry(), env: process.env });
  try {
    return await findRepo(git, path);
  } catch (error) {
    if (error instanceof StartupError) throw new ClientError(error.message, { cause: error });
    throw error;
  }
}

export async function locateInstance(path: string): Promise<Instance> {
  const root = await repoRoot(path);
  const found = findRunningInstance(projectPaths(root).stateDir);
  switch (found.kind) {
    case "none":
      throw new ClientError(
        `mastermind is not running for ${root}. Start it with \`mastermind .\` in that repo.`,
      );
    case "starting":
      throw new ClientError(
        `mastermind is still starting for ${root} (pid ${String(found.pid)}). Try again in a moment.`,
      );
    case "running":
      return { origin: `http://127.0.0.1:${String(found.port)}`, token: found.token };
  }
}
