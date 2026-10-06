import type { PortChoice } from "../api/index.js";
import type { AcceptedAuth } from "../auth.js";
import { checkClaude, createClaudeCli, describeClaudeCheck } from "../claude.js";
import type { ClaudeCli } from "../claude.js";
import { systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import {
  ConfigError,
  durationMs,
  hostPlatform,
  loadConfig,
  prepareProject,
  projectPaths,
} from "../config/index.js";
import type { ConfigContext, ProjectSetupResult } from "../config/index.js";
import type { Config } from "../contracts/index.js";
import { openDb } from "../db/index.js";
import type { Db } from "../db/index.js";
import type { Environment } from "../env.js";
import { createGit } from "../git/index.js";
import type { Git } from "../git/index.js";
import { acquireLock, alreadyRunningMessage } from "../lock.js";
import type { InstanceLock } from "../lock.js";
import { pruneLogs } from "../logs.js";
import type { ProcessRegistry } from "../procs.js";
import { recoverPreviousRun } from "../recovery.js";
import type { RecoveryReport } from "../recovery.js";
import { passAuthGate } from "./auth-gate.js";
import { guardBranch } from "./branch-guard.js";
import { StartupError } from "./errors.js";
import type { StartupPrompts } from "./prompts.js";
import { findRepo } from "./repo.js";
import { describeFirstRun, describeLogPruning, describeRecovery } from "./reports.js";

export const startupBanner = "Ctrl+C twice stops mastermind and every session it started.";

export interface StartupOptions {
  path: string;
  port?: number | undefined;
  env: Environment;
  homeDir: string;
  platform: NodeJS.Platform;
  registry: ProcessRegistry;
  prompts: StartupPrompts;
  clock?: Clock;
}

export interface Startup {
  repoRoot: string;
  branch: string | null;
  config: Config;
  port: PortChoice;
  auth: AcceptedAuth;
  setup: ProjectSetupResult;
  recovery: RecoveryReport;
  lock: InstanceLock;
  db: Db;
  git: Git;
  cli: ClaudeCli;
  close(): void;
}

function sayAll(prompts: StartupPrompts, lines: readonly string[]): void {
  for (const line of lines) prompts.say(line);
}

export function takeLock(stateDir: string): InstanceLock {
  const attempt = acquireLock(stateDir);
  if (attempt.kind === "held")
    throw new StartupError("already-running", alreadyRunningMessage(attempt));
  return attempt.lock;
}

export async function requireClaudeCode(cli: ClaudeCli, prompts: StartupPrompts): Promise<void> {
  const { level, message } = describeClaudeCheck(await checkClaude(cli));
  if (level === "error") throw new StartupError("claude-unavailable", message);
  if (level === "warning") prompts.say(message);
}

export async function loadProjectConfig(context: ConfigContext): Promise<Config> {
  try {
    return await loadConfig(context);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    throw new StartupError("config-invalid", `Invalid config: ${error.message}`, { cause: error });
  }
}

export async function startMastermind(options: StartupOptions): Promise<Startup> {
  const { env, homeDir, registry, prompts } = options;
  const platform = hostPlatform(options.platform);
  if (platform === null)
    throw new StartupError(
      "unsupported-platform",
      `Mastermind runs on macOS and Linux (WSL counts as Linux), not ${options.platform}.`,
    );
  const git = createGit({ registry, env });
  const cli = createClaudeCli({ registry, env });

  const repoRoot = await findRepo(git, options.path);
  const paths = projectPaths(repoRoot);
  const lock = takeLock(paths.stateDir);
  try {
    await requireClaudeCode(cli, prompts);
    const auth = await passAuthGate(cli, prompts);
    const context = { repoRoot, homeDir };
    const { mainBranch } = await loadProjectConfig(context);
    const branch = await guardBranch({ git, repoRoot, mainBranch, prompts });
    const setup = await prepareProject({ ...context, platform });
    if (setup.firstRun) sayAll(prompts, describeFirstRun(setup.detection));
    const config = await loadProjectConfig(context);
    const pruned = await pruneLogs({
      logsDir: paths.logs,
      retentionMs: durationMs(config.logRetention),
      clock: options.clock ?? systemClock,
    });
    sayAll(prompts, describeLogPruning(pruned, config.logRetention));

    const db = openDb(paths.database, { clock: options.clock });
    try {
      const recovery = await recoverPreviousRun({ db, git });
      sayAll(prompts, describeRecovery(recovery));
      prompts.say(startupBanner);
      let open = true;
      const close = (): void => {
        if (!open) return;
        open = false;
        db.close();
        lock.releaseSync();
      };
      const port = { first: options.port ?? config.port, exact: options.port !== undefined };
      return { repoRoot, branch, config, port, auth, setup, recovery, lock, db, git, cli, close };
    } catch (error) {
      db.close();
      throw error;
    }
  } catch (error) {
    lock.releaseSync();
    throw error;
  }
}
