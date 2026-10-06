import { join } from "node:path";

export interface ConfigContext {
  repoRoot: string;
  homeDir: string;
}

export interface ProjectPaths {
  stateDir: string;
  localConfig: string;
  sharedConfig: string;
}

export function projectPaths(repoRoot: string): ProjectPaths {
  const stateDir = join(repoRoot, ".mastermind");
  return {
    stateDir,
    localConfig: join(stateDir, "config.yaml"),
    sharedConfig: join(repoRoot, "mastermind.yaml"),
  };
}
