import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createActionRegistry } from "@mastermind/core/actions";
import type { ActionRegistry } from "@mastermind/core/actions";
import {
  createCheckPipeline,
  createFixerLauncher,
  rerunChecksAction,
} from "@mastermind/core/checks";
import type { CheckPipeline } from "@mastermind/core/checks";
import { createClaudeCli } from "@mastermind/core/claude";
import { defaultConfig, resolveConfig } from "@mastermind/core/config";
import type { ResolvedConfig } from "@mastermind/core/config";
import type { BusEvent, Check, Config, Task } from "@mastermind/core/contracts";
import { openDb, systemClock } from "@mastermind/core/db";
import type { Db } from "@mastermind/core/db";
import { createEventBus } from "@mastermind/core/events";
import type { EventBus } from "@mastermind/core/events";
import { createGit } from "@mastermind/core/git";
import { createProcessRegistry } from "@mastermind/core/procs";
import { approve, createRebaseQueue, discardAction } from "@mastermind/core/rebase";
import type { RebaseQueue } from "@mastermind/core/rebase";
import { createScheduler } from "@mastermind/core/scheduler";
import { createSessionManager } from "@mastermind/core/sessions";
import type { SessionManager } from "@mastermind/core/sessions";
import { onCleanup } from "../../support/cleanup.js";
import type { InvocationRecord, Scenario } from "../../support/fake-claude.js";
import { isolatedEnv } from "../../support/isolated-env.js";
import type { IsolatedEnv } from "../../support/isolated-env.js";
import { waitFor } from "../../support/processes.js";
import { createTempRepo } from "../../support/temp-repo.js";
import type { TempRepo } from "../../support/temp-repo.js";

const promptsDir = fileURLToPath(new URL("../../../prompts/", import.meta.url));

// The build fails while BROKEN is in the tree, and fails once (then passes) while FLAKY is.
const makefile = `build:
\t@if [ -e BROKEN ]; then echo "build failed: BROKEN is present"; exit 1; fi
\t@if [ -e FLAKY ] && [ ! -e .flaky-ran ]; then touch .flaky-ran; echo "build failed: connection reset by peer"; exit 1; fi
\t@echo built
test:
\t@if [ -e FAIL_TEST ]; then echo "tests failed: FAIL_TEST is present"; exit 1; fi
\t@echo tests passed
`;

export interface ChecksHarness {
  env: IsolatedEnv;
  repo: TempRepo;
  db: Db;
  bus: EventBus;
  config: ResolvedConfig;
  manager: SessionManager;
  pipeline: CheckPipeline;
  rebaseQueue: RebaseQueue;
  actions: ActionRegistry;
  events: BusEvent[];
  errors: unknown[];
  startTask(id: string, task?: Partial<Pick<Task, "touches" | "acceptance">>): Promise<void>;
  waitForStatus(id: string, status: Task["status"]): Promise<Task>;
  checks(id: string): Pick<Check, "kind" | "status">[];
  cloneGit(id: string, ...args: string[]): Promise<string>;
  invocationsOf(role: string): Promise<InvocationRecord[]>;
  promptsTo(role: string): Promise<string[]>;
}

export interface ChecksHarnessOptions {
  scenario: Scenario;
  config?: Partial<Config> | ((repo: TempRepo) => Partial<Config>);
  startPipeline?: boolean;
  startRebaseQueue?: boolean;
}

const roleOf = ({ argv }: InvocationRecord): string => {
  const index = argv.indexOf("--append-system-prompt-file");
  const file = index === -1 ? undefined : argv[index + 1];
  if (file !== undefined) return basename(file, ".md");
  return argv.includes("--max-turns") ? "judge" : "unknown";
};

export async function checksHarness(options: ChecksHarnessOptions): Promise<ChecksHarness> {
  const repo = await createTempRepo({
    files: { "README.md": "# Demo\n", Makefile: makefile, "src/app.ts": "export {};\n" },
  });
  const env = await isolatedEnv();
  await env.writeScenario(options.scenario);

  const context = { repoRoot: repo.path, homeDir: env.home };
  const config = resolveConfig(
    {
      ...defaultConfig(context),
      worktreeDir: join(env.worktreeRoot, "demo"),
      commands: { setup: "", build: "make build", test: "make test" },
      reviewer: { enabled: false },
      ...(typeof options.config === "function" ? options.config(repo) : options.config),
    },
    { ...context, plan: "max" },
  );
  const db = openDb(join(env.root, "db.sqlite"));
  const bus = createEventBus();
  const events: BusEvent[] = [];
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  bus.subscribe((event) => events.push(event));
  const registry = createProcessRegistry();
  const git = createGit({ registry, env: env.env });
  const cli = createClaudeCli({ registry, env: env.env });
  const scheduler = createScheduler({
    db,
    bus,
    clock: systemClock,
    maxWorkers: () => config.maxWorkers,
    startTask: () => Promise.resolve(),
    onError,
  });
  const shared = { db, bus, cli, git, registry, env: env.env, repoRoot: repo.path, promptsDir };
  const manager = createSessionManager({
    ...shared,
    homeDir: env.home,
    config: () => config,
    backoff: scheduler,
    pathGuardCommand: ["node", "/opt/mastermind/path-guard.js"],
    onError,
  });
  const launcher = createFixerLauncher({
    db,
    bus,
    clock: systemClock,
    maxAttempts: () => config.maxAttempts,
    fixers: manager,
    onError,
  });
  const gitWork = {
    ...shared,
    logsDir: join(env.root, "logs"),
    config: () => config,
    launcher,
    onError,
  };
  const pipeline = createCheckPipeline({ ...gitWork, backoff: scheduler });
  const rebaseQueue = createRebaseQueue({ ...gitWork, checkoutPollMs: 50 });
  const actions = createActionRegistry(
    { db, bus, config: { set: () => Promise.reject(new Error("config is fixed in tests")) } },
    [
      rerunChecksAction(pipeline),
      approve,
      discardAction({ git, repoRoot: repo.path, config: () => config, clock: systemClock }),
    ],
  );
  onCleanup(() => {
    rebaseQueue.stop();
    pipeline.stop();
    registry.killAllSync();
    db.close();
  });
  if (options.startPipeline ?? true) pipeline.start();
  if (options.startRebaseQueue ?? false) rebaseQueue.start();

  const invocationsOf = async (role: string) =>
    (await env.invocations()).filter((invocation) => roleOf(invocation) === role);

  return {
    env,
    repo,
    db,
    bus,
    config,
    manager,
    pipeline,
    rebaseQueue,
    actions,
    events,
    errors,
    async startTask(id, task) {
      const created = db.tasks.create({
        id,
        title: `Build ${id}`,
        goal: `Make ${id} work.`,
        acceptance: "test -f src/feature.txt",
        touches: ["src/"],
        ...task,
      });
      await manager.startTask(created);
    },
    waitForStatus: (id, status) =>
      waitFor(() => {
        const task = db.tasks.get(id);
        return task?.status === status && task;
      }, 25_000),
    checks: (id) => db.checks.listForTask(id).map(({ kind, status }) => ({ kind, status })),
    cloneGit: async (id, ...args) => (await git.run(join(config.worktreeDir, id), args)).trim(),
    invocationsOf,
    async promptsTo(role) {
      const pids = new Set((await invocationsOf(role)).map((invocation) => invocation.pid));
      return (await env.readLog()).flatMap((record) =>
        record.kind === "message" && pids.has(record.pid) ? [record.text] : [],
      );
    },
  };
}
