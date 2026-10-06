import { basename, join } from "node:path";
import { serveApi } from "./api/index.js";
import type { ServedApi } from "./api/index.js";
import { builtinActions, createActionRegistry, pause, resume } from "./actions/index.js";
import type { ActionRegistry } from "./actions/index.js";
import { createCheckPipeline, createFixerLauncher, rerunChecksAction } from "./checks/index.js";
import { systemClock } from "./clock.js";
import type { Clock } from "./clock.js";
import {
  actionTools,
  buildDigest,
  chatActions,
  conductorMcpConfigPath,
  conductorSystemPromptPath,
  createChatRunner,
  createConductorSummariser,
  postEventLines,
  readDigestInput,
  writeConductorMcpConfig,
  wakeOnEventLines,
  writeConductorSystemPrompt,
} from "./conductor/index.js";
import { projectPaths, resolveConfig, setConfig } from "./config/index.js";
import type { ResolvedConfig } from "./config/index.js";
import type { Config, RuntimeFlags } from "./contracts/index.js";
import type { KilledCounts } from "./db/index.js";
import type { Environment } from "./env.js";
import { createEventBus } from "./events.js";
import type { EventBus } from "./events.js";
import type { AuthVerdict } from "./auth.js";
import { GitError } from "./git/index.js";
import { notifyOwner } from "./notify.js";
import type { NativeNotifier } from "./notify.js";
import type { KillReport, ProcessRegistry } from "./procs.js";
import { createProposalGate, proposalActions } from "./proposals.js";
import { approve, createRebaseQueue, discardAction } from "./rebase/index.js";
import { requestChangesAction, reviewNoteActions } from "./review/index.js";
import { createScheduler } from "./scheduler.js";
import type { Scheduler } from "./scheduler.js";
import {
  createOneShotRunner,
  createSessionManager,
  createSessionSpawner,
  messageSessionAction,
  stopSessionAction,
} from "./sessions/index.js";
import { createSignInMonitor } from "./sign-in.js";
import type { Startup } from "./startup/index.js";
import { createStatusStore } from "./status.js";
import type { StatusStore } from "./status.js";
import { createTerminals } from "./terminals.js";

export interface RuntimeOptions {
  startup: Startup;
  registry: ProcessRegistry;
  env: Environment;
  homeDir: string;
  promptsDir: string;
  webRoot: string;
  pathGuardCommand: readonly string[];
  nativeNotifier: NativeNotifier;
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
  signIn(): Promise<AuthVerdict | null>;
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
async function closeOnFailure<T>(api: ServedApi, build: () => T | Promise<T>): Promise<T> {
  try {
    return await build();
  } catch (error) {
    api.closeSync();
    throw error;
  }
}

export async function createRuntime(options: RuntimeOptions): Promise<Runtime> {
  const { startup, registry, env, homeDir, onError, clock = systemClock } = options;
  const { repoRoot, db } = startup;
  const { stateDir } = projectPaths(repoRoot);
  const context = { repoRoot, homeDir };
  const resolve = (merged: Config): ResolvedConfig =>
    resolveConfig(merged, { ...context, plan: startup.auth.plan });
  let projectConfig = startup.config;
  let config = resolve(projectConfig);

  const bus = createEventBus({ onListenerError: onError });
  const actions = createActionRegistry(
    {
      db,
      bus,
      config: {
        async set(change) {
          projectConfig = await setConfig(context, change);
          config = resolve(projectConfig);
          return projectConfig;
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
    startTask: async (task) => {
      if (await signIn.ensureSignedIn()) await manager.startTask(task);
    },
    onError,
  });
  // The startup's auth gate has just accepted the sign-in.
  const signIn = createSignInMonitor({
    db,
    bus,
    cli: startup.cli,
    clock,
    onError,
    lastCheckedAt: clock.now(),
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
  actions.register(messageSessionAction(manager));
  actions.register(requestChangesAction(manager));
  for (const action of reviewNoteActions) actions.register(action);
  const launcher = createFixerLauncher({
    db,
    bus,
    clock,
    maxAttempts: () => config.maxAttempts,
    fixers: manager,
    signedIn: () => signIn.ensureSignedIn(),
    onError,
  });
  const gitWork = {
    db,
    bus,
    git: startup.git,
    registry,
    env,
    repoRoot,
    logsDir: join(stateDir, "logs"),
    config: () => config,
    launcher,
    onError,
    clock,
  };
  const pipeline = createCheckPipeline({
    ...gitWork,
    cli: startup.cli,
    promptsDir: options.promptsDir,
    backoff: scheduler,
  });
  actions.register(rerunChecksAction(pipeline));
  const rebaseQueue = createRebaseQueue(gitWork);
  actions.register(approve);
  actions.register(discardAction({ git: startup.git, repoRoot, config: () => config, clock }));
  const gate = createProposalGate({
    db,
    bus,
    actions,
    clock,
    tools: actionTools,
    confirmList: () => config.conductor.confirm,
    activeTurn: () => runner.activeTurn(),
  });
  for (const action of proposalActions(gate)) actions.register(action);
  const mcpConfigPath = conductorMcpConfigPath(stateDir);
  const systemPromptFile = conductorSystemPromptPath(stateDir);
  await writeConductorSystemPrompt(options.promptsDir, systemPromptFile);
  const runner = createChatRunner({
    db,
    bus,
    cli: startup.cli,
    repoRoot,
    systemPromptFile,
    logsDir: join(stateDir, "logs"),
    mcpConfigPath,
    model: () => config.models.conductor,
    digest: () => buildDigest(readDigestInput({ db, clock, summary: () => scheduler.summary() })),
    backoff: scheduler,
    summariser: createConductorSummariser({
      db,
      repoRoot,
      model: () => config.models.judge,
      oneShot: createOneShotRunner({
        db,
        bus,
        backoff: scheduler,
        spawner: createSessionSpawner({
          db,
          bus,
          cli: startup.cli,
          logsDir: join(stateDir, "logs"),
          onError,
        }),
      }),
    }),
    onError,
  });
  for (const action of chatActions(runner)) actions.register(action);
  const terminals = createTerminals({ db, bus, registry, env });

  const mainCommit = await shortCommit(startup, config.mainBranch);
  const api = await serveApi({
    db,
    git: startup.git,
    bus,
    actions,
    gate,
    chat: runner,
    terminals,
    instance: {
      project: basename(repoRoot),
      account: { email: startup.auth.email, plan: startup.auth.plan },
    },
    summary: () => scheduler.summary(),
    config: () => projectConfig,
    webRoot: options.webRoot,
    onError,
    stateDir,
    lock: startup.lock,
    port: startup.port,
  });

  await closeOnFailure(api, () =>
    writeConductorMcpConfig(mcpConfigPath, { port: api.port, token: api.token }),
  );
  const store = await closeOnFailure(api, () =>
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

  const stopEventLines = postEventLines({ db, bus, mainBranch: () => config.mainBranch });
  const stopWaking = wakeOnEventLines({
    bus,
    wakeOnEvents: () => config.conductor.wakeOnEvents,
    wake: () => {
      runner.wake();
    },
  });
  const stopNotifications = notifyOwner({
    bus,
    project: basename(repoRoot),
    enabled: () => config.notifications.desktop,
    webClientConnected: () => api.webClientConnected(),
    native: options.nativeNotifier,
    onError,
  });

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
      signIn.start();
      scheduler.start();
      pipeline.start();
      rebaseQueue.start();
      expireProposals();
      proposalSweep = setInterval(expireProposals, proposalSweepMs);
    },

    togglePause() {
      return actions.run(db.flags.get().paused ? resume : pause, {});
    },

    signIn: () => signIn.signIn(),

    killProcessesSync() {
      const report = registry.killAllSync();
      terminals.killAllSync();
      return report;
    },

    markKilledSync: () => db.killRunning(),

    closeSync() {
      if (proposalSweep !== null) clearInterval(proposalSweep);
      signIn.stop();
      stopEventLines();
      stopWaking();
      stopNotifications();
      terminals.dispose();
      runner.dispose();
      api.closeSync();
      rebaseQueue.stop();
      pipeline.stop();
      scheduler.stop();
      store.dispose();
      startup.close();
    },
  };
}
