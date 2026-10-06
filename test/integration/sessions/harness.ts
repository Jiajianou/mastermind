import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeCli } from "@mastermind/core/claude";
import { defaultConfig, resolveConfig } from "@mastermind/core/config";
import type { ResolvedConfig } from "@mastermind/core/config";
import type { BusEvent, Config, Task } from "@mastermind/core/contracts";
import { openDb, systemClock } from "@mastermind/core/db";
import type { Db } from "@mastermind/core/db";
import { createEventBus } from "@mastermind/core/events";
import { createGit } from "@mastermind/core/git";
import { createProcessRegistry } from "@mastermind/core/procs";
import { createScheduler } from "@mastermind/core/scheduler";
import { createSessionManager } from "@mastermind/core/sessions";
import type { SessionManager } from "@mastermind/core/sessions";
import { onCleanup } from "../../support/cleanup.js";
import type { Scenario } from "../../support/fake-claude.js";
import { isolatedEnv } from "../../support/isolated-env.js";
import type { IsolatedEnv } from "../../support/isolated-env.js";
import { waitFor } from "../../support/processes.js";
import { createTempRepo } from "../../support/temp-repo.js";
import type { TempRepo } from "../../support/temp-repo.js";

export const promptsDir = fileURLToPath(new URL("../../../prompts/", import.meta.url));
export const pathGuardCommand = ["node", "/opt/mastermind/path-guard.js"];

export interface SessionHarness {
  env: IsolatedEnv;
  repo: TempRepo;
  db: Db;
  config: ResolvedConfig;
  manager: SessionManager;
  events: BusEvent[];
  errors: unknown[];
  addTask(id: string): Task;
  waitForStatus(id: string, status: Task["status"]): Promise<Task>;
  cloneGit(id: string, ...args: string[]): Promise<string>;
}

export interface HarnessOptions {
  scenario: Scenario;
  config?: Partial<Config>;
}

const leakedEnv = {
  ANTHROPIC_API_KEY: "sk-ant-api03-leak",
  ANTHROPIC_BASE_URL: "https://proxy.example.com",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDECODE: "1",
  CLAUDE_CODE_MESSAGING_TOKEN: "parent-session-token",
};

export async function sessionHarness(options: HarnessOptions): Promise<SessionHarness> {
  const repo = await createTempRepo({
    files: { "README.md": "# Demo\n", "src/app.ts": "export const answer = 41;\n" },
  });
  const env = await isolatedEnv({ env: { ...leakedEnv, GIT_DIR: join(repo.path, ".git") } });
  await env.writeScenario(options.scenario);

  const context = { repoRoot: repo.path, homeDir: env.home };
  const config = resolveConfig(
    { ...defaultConfig(context), worktreeDir: join(env.worktreeRoot, "demo"), ...options.config },
    { ...context, plan: "max" },
  );
  const db = openDb(join(env.root, "db.sqlite"));
  const bus = createEventBus();
  const events: BusEvent[] = [];
  const errors: unknown[] = [];
  bus.subscribe((event) => events.push(event));
  const registry = createProcessRegistry();
  onCleanup(() => {
    registry.killAllSync();
    db.close();
  });
  const scheduler = createScheduler({
    db,
    bus,
    clock: systemClock,
    maxWorkers: () => config.maxWorkers,
    startTask: () => Promise.resolve(),
    onError: (error) => errors.push(error),
  });
  const manager = createSessionManager({
    db,
    bus,
    cli: createClaudeCli({ registry, env: env.env }),
    git: createGit({ registry, env: env.env }),
    registry,
    env: env.env,
    repoRoot: repo.path,
    homeDir: env.home,
    promptsDir,
    config: () => config,
    backoff: scheduler,
    pathGuardCommand,
    onError: (error) => errors.push(error),
  });
  const clonePath = (id: string) => join(config.worktreeDir, id);

  return {
    env,
    repo,
    db,
    config,
    manager,
    events,
    errors,
    addTask: (id) =>
      db.tasks.create({
        id,
        title: `Build ${id}`,
        goal: `Make ${id} work.`,
        acceptance: "make test",
        touches: ["src/"],
      }),
    waitForStatus: (id, status) =>
      waitFor(() => {
        const task = db.tasks.get(id);
        return task?.status === status && task;
      }, 15_000),
    cloneGit: async (id, ...args) => {
      const git = createGit({ registry, env: env.env });
      return (await git.run(clonePath(id), args)).trim();
    },
  };
}
