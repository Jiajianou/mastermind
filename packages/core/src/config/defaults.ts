import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { Config } from "../contracts/config.js";
import type { ConfigContext } from "./paths.js";

export function defaultWorktreeDir({ repoRoot, homeDir }: ConfigContext): string {
  const repoName = basename(repoRoot).replace(/[^\w.-]+/g, "-");
  const pathHash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 6);
  return join(homeDir, ".mastermind", "worktrees", `${repoName}-${pathHash}`);
}

export function defaultConfig(context: ConfigContext): Config {
  return {
    mainBranch: "main",
    worktreeDir: defaultWorktreeDir(context),
    maxWorkers: "auto",
    maxAttempts: 3,
    models: {
      worker: "opus",
      fixer: "opus",
      reviewer: "sonnet",
      judge: "haiku",
      conductor: "opus",
    },
    commands: { setup: "", build: "", test: "" },
    autoRebase: true,
    requireReviewFor: [],
    workerPermissions: "bypass",
    workerAllowedTools: ["Bash(git *)", "Bash(make *)"],
    reviewer: { enabled: true },
    notifications: { desktop: true },
    stuckCheck: { after: "60m", every: "20m" },
    sandbox: { enabled: true, allowedDomains: [], allowWrite: [] },
    conductor: {
      confirm: ["approve_rebase", "rebase_my_branch", "discard_task", "set_config"],
      wakeOnEvents: [],
    },
    port: 4700,
  };
}
