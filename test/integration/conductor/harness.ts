import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinActions, createActionRegistry } from "@mastermind/core/actions";
import { serveApi } from "@mastermind/core/api";
import { createClaudeCli } from "@mastermind/core/claude";
import {
  actionTools,
  buildDigest,
  chatActions,
  conductorMcpConfigPath,
  createChatRunner,
  postEventLines,
  readDigestInput,
  writeConductorMcpConfig,
} from "@mastermind/core/conductor";
import type { ChatRunner } from "@mastermind/core/conductor";
import { loadConfig, projectPaths, setConfig } from "@mastermind/core/config";
import type { BusEvent, ChatMessage, Config } from "@mastermind/core/contracts";
import { openDb, systemClock } from "@mastermind/core/db";
import type { Db } from "@mastermind/core/db";
import { createEventBus } from "@mastermind/core/events";
import type { EventBus } from "@mastermind/core/events";
import { createProcessRegistry } from "@mastermind/core/procs";
import type { ProcessRegistry } from "@mastermind/core/procs";
import { createProposalGate, proposalActions } from "@mastermind/core/proposals";
import { createScheduler } from "@mastermind/core/scheduler";
import type { Scheduler } from "@mastermind/core/scheduler";
import { z } from "zod";
import { onCleanup } from "../../support/cleanup.js";
import type { Scenario } from "../../support/fake-claude.js";
import { isolatedEnv } from "../../support/isolated-env.js";
import type { IsolatedEnv } from "../../support/isolated-env.js";
import { waitFor } from "../../support/processes.js";
import { createTempRepo } from "../../support/temp-repo.js";
import type { TempRepo } from "../../support/temp-repo.js";
import { freePort } from "../api/harness.js";

const promptsDir = fileURLToPath(new URL("../../../prompts/", import.meta.url));

export const leakedEnv = {
  ANTHROPIC_API_KEY: "sk-ant-api03-leak",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_MESSAGING_TOKEN: "parent-session-token",
};

export interface ConductorHarness {
  env: IsolatedEnv;
  repo: TempRepo;
  db: Db;
  bus: EventBus;
  registry: ProcessRegistry;
  scheduler: Scheduler;
  runner: ChatRunner;
  events: BusEvent[];
  errors: unknown[];
  mcpConfigPath: string;
  config(): Config;
  post(path: string, body?: unknown): Promise<unknown>;
  get(path: string): Promise<unknown>;
  waitForTurnEnd(turnId: string): Promise<ChatMessage[]>;
  messages(turnId?: string): ChatMessage[];
}

export interface ConductorHarnessOptions {
  scenario: Scenario;
  idleMs?: number;
}

const apiErrorSchema = z.object({ message: z.string() });

export async function conductorHarness(
  options: ConductorHarnessOptions,
): Promise<ConductorHarness> {
  const repo = await createTempRepo({ files: { "README.md": "# Demo\n" } });
  const env = await isolatedEnv({ env: leakedEnv });
  await env.writeScenario(options.scenario);
  const { stateDir } = projectPaths(repo.path);
  const configContext = { repoRoot: repo.path, homeDir: env.home };
  let config = await loadConfig(configContext);

  const db = openDb(join(env.root, "db.sqlite"));
  const bus = createEventBus();
  const events: BusEvent[] = [];
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  bus.subscribe((event) => events.push(event));
  const registry = createProcessRegistry();

  const actions = createActionRegistry(
    {
      db,
      bus,
      config: {
        async set(change) {
          config = await setConfig(configContext, change);
          return config;
        },
      },
    },
    builtinActions,
  );
  const scheduler = createScheduler({
    db,
    bus,
    clock: systemClock,
    maxWorkers: () => 2,
    startTask: () => Promise.resolve(),
    onError,
  });
  const gate = createProposalGate({
    db,
    bus,
    actions,
    clock: systemClock,
    tools: actionTools,
    confirmList: () => config.conductor.confirm,
    activeTurn: () => runner.activeTurn(),
  });
  for (const action of proposalActions(gate)) actions.register(action);
  const mcpConfigPath = conductorMcpConfigPath(stateDir);
  const runner = createChatRunner({
    db,
    bus,
    cli: createClaudeCli({ registry, env: env.env }),
    repoRoot: repo.path,
    promptsDir,
    logsDir: join(stateDir, "logs"),
    mcpConfigPath,
    model: () => config.models.conductor,
    digest: () =>
      buildDigest(readDigestInput({ db, clock: systemClock, summary: () => scheduler.summary() })),
    backoff: scheduler,
    onError,
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
  });
  for (const action of chatActions(runner)) actions.register(action);
  const stopEventLines = postEventLines({ db, bus, mainBranch: () => config.mainBranch });

  const api = await serveApi({
    db,
    bus,
    actions,
    gate,
    chat: runner,
    summary: () => scheduler.summary(),
    webRoot: join(env.root, "no-web"),
    onError,
    stateDir,
    lock: { setPort: () => undefined },
    port: { first: await freePort(), exact: false },
  });
  await writeConductorMcpConfig(mcpConfigPath, { port: api.port, token: api.token });
  onCleanup(() => {
    stopEventLines();
    runner.dispose();
    scheduler.stop();
    registry.killAllSync();
    api.closeSync();
    db.close();
    if (errors.length > 0) throw new AggregateError(errors, "the chat reported errors");
  });

  async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`http://127.0.0.1:${String(api.port)}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${api.token}`,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    const json: unknown = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${apiErrorSchema.parse(json).message}`);
    return json;
  }

  const messages = (turnId?: string) =>
    db.chat.list().filter((message) => turnId === undefined || message.turnId === turnId);

  return {
    env,
    repo,
    db,
    bus,
    registry,
    scheduler,
    runner,
    events,
    errors,
    mcpConfigPath,
    config: () => config,
    post: (path, body) => request("POST", path, body),
    get: (path) => request("GET", path),
    async waitForTurnEnd(turnId) {
      await waitFor(
        () =>
          events.some(
            (event) => event.type === "chat.turn" && event.turnId === turnId && !event.replying,
          ),
        15_000,
      );
      return messages(turnId);
    },
    messages,
  };
}
