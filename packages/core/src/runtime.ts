import { basename } from "node:path";
import { serveApi } from "./api/index.js";
import type { ServedApi } from "./api/index.js";
import { builtinActions, createActionRegistry, pause, resume } from "./actions/index.js";
import type { ActionRegistry } from "./actions/index.js";
import { systemClock } from "./clock.js";
import type { Clock } from "./clock.js";
import { actionTools } from "./conductor/index.js";
import { projectPaths, resolveConfig, setConfig } from "./config/index.js";
import type { ResolvedConfig } from "./config/index.js";
import type { Config, RuntimeFlags } from "./contracts/index.js";
import type { KilledCounts } from "./db/index.js";
import type { Environment } from "./env.js";
import { createEventBus } from "./events.js";
import type { EventBus } from "./events.js";
import { GitError } from "./git/index.js";
import type { KillReport, ProcessRegistry } from "./procs.js";
import { createProposalGate, proposalActions } from "./proposals.js";
import { createScheduler } from "./scheduler.js";
import type { Scheduler } from "./scheduler.js";
import { createSessionManager, stopSessionAction } from "./sessions/index.js";
import type { Startup } from "./startup/index.js";
import { createStatusStore } from "./status.js";
import type { StatusStore } from "./status.js";

export interface RuntimeOptions {
  startup: Startup;
  registry: ProcessRegistry;
  env: Environment;
  homeDir: string;
  promptsDir: string;
  webRoot: string;
  pathGuardCommand: readonly string[];
  onError: (error: unknown) => void;
  clock?: Clock;
}

export interface Runtime {
  bus: EventBus;
  actions: ActionRegistry;
  scheduler: Scheduler;
  store: StatusStore;
  start(): void;
  togglePause(): Promise<RuntimeFlags>;
  killProcessesSync(): KillReport;
  markKilledSync(): KilledCounts;
  closeSync(): void;
}

const proposalSweepMs = 60_000;

async function shortCommit(startup: Startup, ref: string): Promise<string | null> {
  try {
    return (await startup.git.run(startup.repoRoot, ["rev-parse", "--short", ref])).trim();
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

// A listening server keeps the process alive, so a runtime that fails to finish must not leave it open.
function closeOnFailure<T>(api: ServedApi, build: () => T): T {
  try {
    return build();
  } catch (error) {
    api.closeSync();
    throw error;
  }
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const { startup, registry, env, homeDir, onError, clock = systemClock } = options;
  const { repoRoot, db } = startup;
  const context = { repoRoot, homeDir };
  const resolve = (merged: Config): ResolvedConfig =>
    resolveConfig(merged, { ...context, plan: startup.auth.plan });
  let config = resolve(startup.config);

  const bus = createEventBus({ onListenerError: onError });
  const actions = createActionRegistry(
    {
      db,
      bus,
      config: {
        async set(change) {
          const merged = await setConfig(context, change);
          config = resolve(merged);
          return merged;
        },
      },
    },
    builtinActions,
  );
  const scheduler = createScheduler({
    db,
    bus,
    clock,
    maxWorkers: () => config.maxWorkers,
    startTask: (task) => manager.startTask(task),
    onError,
  });
  const manager = createSessionManager({
    db,
    bus,
    cli: startup.cli,
    git: startup.git,
    registry,
    env,
    repoRoot,
    homeDir,
    promptsDir: options.promptsDir,
    config: () => config,
    backoff: scheduler,
    pathGuardCommand: options.pathGuardCommand,
    onError,
    clock,
  });
  actions.register(stopSessionAction(manager));
  const gate = createProposalGate({
    db,
    bus,
    actions,
    clock,
    tools: actionTools,
    confirmList: () => config.conductor.confirm,
  });
  for (const action of proposalActions(gate)) actions.register(action);

  const mainCommit = await shortCommit(startup, config.mainBranch);
  const api = await serveApi({
    db,
    bus,
    actions,
    gate,
    summary: () => scheduler.summary(),
    webRoot: options.webRoot,
    onError,
    stateDir: projectPaths(repoRoot).stateDir,
    lock: startup.lock,
    port: startup.port,
  });

  const store = closeOnFailure(api, () =>
    createStatusStore({
      db,
      bus,
      clock,
      header: {
        repoName: basename(repoRoot),
        mainBranch: config.mainBranch,
        mainCommit,
        email: startup.auth.email,
        plan: startup.auth.plan,
        link: api.link,
      },
      summary: () => scheduler.summary(),
      maxAttempts: () => config.maxAttempts,
    }),
  );

  let proposalSweep: ReturnType<typeof setInterval> | null = null;
  const expireProposals = () => {
    try {
      gate.expireStale();
    } catch (error) {
      onError(error);
    }
  };

  return {
    bus,
    actions,
    scheduler,
    store,

    start() {
      scheduler.start();
      expireProposals();
      proposalSweep = setInterval(expireProposals, proposalSweepMs);
    },

    togglePause() {
      return actions.run(db.flags.get().paused ? resume : pause, {});
    },

    killProcessesSync: () => registry.killAllSync(),

    markKilledSync: () => db.killRunning(),

    closeSync() {
      if (proposalSweep !== null) clearInterval(proposalSweep);
      api.closeSync();
      scheduler.stop();
      store.dispose();
      startup.close();
    },
  };
}
