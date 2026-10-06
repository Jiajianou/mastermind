import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import type { Server } from "node:net";
import { join } from "node:path";
import { builtinActions, createActionRegistry } from "@mastermind/core/actions";
import { serveApi } from "@mastermind/core/api";
import type { PortChoice, ServedApi } from "@mastermind/core/api";
import { actionTools } from "@mastermind/core/conductor";
import { loadConfig, setConfig } from "@mastermind/core/config";
import type { InstanceInfo } from "@mastermind/core/contracts";
import { openDb, systemClock } from "@mastermind/core/db";
import type { Db } from "@mastermind/core/db";
import { createEventBus } from "@mastermind/core/events";
import { acquireLock, tokenPath } from "@mastermind/core/lock";
import { createProposalGate, proposalActions } from "@mastermind/core/proposals";
import { createScheduler } from "@mastermind/core/scheduler";
import { stopSessionAction } from "@mastermind/core/sessions";
import { makeTempDir, onCleanup } from "../../support/cleanup.js";

export interface TestApi {
  api: ServedApi;
  db: Db;
  stateDir: string;
  webRoot: string;
  errors: unknown[];
  authorization: string;
  url(path: string): string;
}

export const testInstance: InstanceInfo = {
  project: "demo",
  account: { email: "owner@example.com", plan: "max" },
};

export const webIndex = "<!doctype html><title>Mastermind</title>";
export const webScript = "console.log('mastermind');";

async function writeWebApp(root: string): Promise<string> {
  const webRoot = join(root, "web");
  await mkdir(join(webRoot, "assets"), { recursive: true });
  await writeFile(join(webRoot, "index.html"), webIndex);
  await writeFile(join(webRoot, "assets", "app.js"), webScript);
  return webRoot;
}

async function listening(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject).listen(port, "127.0.0.1", resolve);
  });
  return server;
}

export async function occupyPort(port = 0): Promise<number> {
  const server = await listening(port);
  onCleanup(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  return address.port;
}

export async function freePort(): Promise<number> {
  const server = await listening(0);
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  return address.port;
}

export interface TestApiOptions {
  port?: PortChoice;
  staleToken?: string;
}

export async function serveTestApi({ port, staleToken }: TestApiOptions = {}): Promise<TestApi> {
  const root = await makeTempDir("api");
  const stateDir = join(root, ".mastermind");
  if (staleToken !== undefined) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(tokenPath(stateDir), staleToken, { mode: 0o644 });
  }
  const attempt = acquireLock(stateDir);
  if (attempt.kind !== "acquired") throw new Error("the test lock is held");
  const { lock } = attempt;
  onCleanup(() => {
    lock.releaseSync();
  });
  const db = openDb(join(stateDir, "db.sqlite"));
  onCleanup(() => {
    db.close();
  });
  const bus = createEventBus();
  const configContext = { repoRoot: root, homeDir: root };
  let config = await loadConfig(configContext);
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
  // The real session manager's stop is covered by the worker session tests; here it only has to end the row.
  actions.register(
    stopSessionAction({
      stopSession: (sessionId) => {
        db.sessions.end(sessionId, { status: "stopped" });
        return Promise.resolve();
      },
    }),
  );
  const gate = createProposalGate({
    db,
    bus,
    actions,
    clock: systemClock,
    tools: actionTools,
    confirmList: () => config.conductor.confirm,
    activeTurn: () => null,
  });
  for (const action of proposalActions(gate)) actions.register(action);
  const errors: unknown[] = [];
  onCleanup(() => {
    if (errors.length > 0) throw new AggregateError(errors, "the API reported errors");
  });
  const scheduler = createScheduler({
    db,
    bus,
    clock: systemClock,
    maxWorkers: () => 2,
    startTask: () => Promise.resolve(),
    onError: (error) => errors.push(error),
  });
  const webRoot = await writeWebApp(root);
  const api = await serveApi({
    db,
    bus,
    actions,
    gate,
    chat: {
      status: () => ({ model: config.models.conductor, replying: false }),
      activeTurn: () => null,
    },
    instance: testInstance,
    summary: () => scheduler.summary(),
    config: () => config,
    webRoot,
    onError: (error) => errors.push(error),
    stateDir,
    lock,
    port: port ?? { first: await freePort(), exact: false },
  });
  onCleanup(() => {
    api.closeSync();
  });
  return {
    api,
    db,
    stateDir,
    webRoot,
    errors,
    authorization: `Bearer ${api.token}`,
    url: (path) => `http://127.0.0.1:${String(api.port)}${path}`,
  };
}
