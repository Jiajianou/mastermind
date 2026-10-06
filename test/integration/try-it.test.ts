import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { projectPaths } from "@mastermind/core/config";
import {
  apiErrorSchema,
  apiResponseSchemas,
  streamMessageSchema,
  streamPath,
  streamProtocols,
} from "@mastermind/core/contracts";
import type { StreamMessage } from "@mastermind/core/contracts";
import { openDb } from "@mastermind/core/db";
import type { Db } from "@mastermind/core/db";
import { readLock, tokenPath } from "@mastermind/core/lock";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { makeTempDir, onCleanup } from "../support/cleanup.js";
import { spawnCli } from "../support/cli.js";
import { isolatedEnv } from "../support/isolated-env.js";
import { findPids, isAlive, processTable, waitFor } from "../support/processes.js";
import { createTempRepo } from "../support/temp-repo.js";
import { serveTestApi } from "./api/harness.js";

interface Server {
  url(path: string): string;
  authorization: string;
}

async function post(server: Server, path: string, body?: unknown): Promise<Response> {
  return fetch(server.url(path), {
    method: "POST",
    headers: {
      authorization: server.authorization,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function openTerminal(server: Server, taskId: string) {
  const response = await post(server, `/api/tasks/${taskId}/terminal`, { cols: 100, rows: 30 });
  expect(response.status).toBe(200);
  return apiResponseSchemas.terminalView.parse(await response.json()).terminal;
}

async function type(server: Server, terminalId: string, data: string): Promise<Response> {
  return post(server, `/api/terminals/${terminalId}/input`, { data });
}

async function listen(server: Server, token: string): Promise<StreamMessage[]> {
  const socket = new WebSocket(
    server.url(streamPath).replace("http:", "ws:"),
    streamProtocols(token),
  );
  onCleanup(() => {
    socket.terminate();
  });
  const messages: StreamMessage[] = [];
  socket.on("message", (data: Buffer) => {
    messages.push(streamMessageSchema.parse(JSON.parse(data.toString("utf8"))));
  });
  await once(socket, "open");
  return messages;
}

const outputOf = (messages: readonly StreamMessage[], terminalId: string): string =>
  messages
    .flatMap((message) =>
      message.type === "terminal.output" && message.terminalId === terminalId ? [message.data] : [],
    )
    .join("");

async function seedTaskInReview(db: Db, worktree: string): Promise<void> {
  await mkdir(worktree, { recursive: true });
  db.tasks.create({
    id: "alpha",
    title: "Alpha",
    goal: "Build alpha.",
    acceptance: "true",
    touches: [],
  });
  db.tasks.update("alpha", { status: "review", worktree });
}

async function startLongCommand(server: Server, terminalId: string) {
  const marker = `try-it-${randomUUID()}`;
  expect((await type(server, terminalId, `sh -c 'sleep 300; true' ${marker}\r`)).status).toBe(200);
  return waitFor(() => {
    const pids = findPids(marker);
    const table = processTable();
    const command = pids.length === 1 && table.find(({ pid }) => pid === pids[0]);
    const sleep = command && table.find(({ ppid }) => ppid === command.pid);
    return sleep && [command.ppid, command.pid, sleep.pid];
  }, 10_000);
}

async function waitForDeath(pids: readonly number[]): Promise<void> {
  await waitFor(() => !pids.some(isAlive));
}

async function scrollback(server: Server, taskId: string): Promise<string | undefined> {
  const read = await fetch(server.url(`/api/tasks/${taskId}/terminal`), {
    headers: { authorization: server.authorization },
  });
  const terminal = apiResponseSchemas.taskTerminal.parse(await read.json());
  return terminal.available ? terminal.view?.output : undefined;
}

describe("Try it yourself", () => {
  it("streams a command typed into a task's terminal, run in the task's workspace", async () => {
    const test = await serveTestApi();
    const worktree = join(test.root, "worktrees", "alpha");
    await seedTaskInReview(test.db, worktree);
    const messages = await listen(test, test.api.token);

    const terminal = await openTerminal(test, "alpha");
    expect(terminal).toMatchObject({ taskId: "alpha", cwd: worktree, status: "running" });
    expect((await type(test, terminal.id, "echo hi && pwd\r")).status).toBe(200);

    await waitFor(() => outputOf(messages, terminal.id).includes(`\nhi\r\n${worktree}\r\n`));
    await waitFor(
      async () => (await scrollback(test, "alpha")) === outputOf(messages, terminal.id),
    );
  });

  it("Stop kills the terminal and the command running in it", async () => {
    const test = await serveTestApi();
    await seedTaskInReview(test.db, join(test.root, "worktrees", "alpha"));
    const messages = await listen(test, test.api.token);
    const terminal = await openTerminal(test, "alpha");
    const processes = await startLongCommand(test, terminal.id);

    const stopped = await post(test, `/api/terminals/${terminal.id}/stop`);

    expect(stopped.status).toBe(200);
    expect(apiResponseSchemas.terminal.parse(await stopped.json()).status).toBe("exited");
    await waitForDeath(processes);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "terminal.updated",
        terminal: { ...terminal, status: "exited" },
      }),
    );
    const late = await type(test, terminal.id, "echo late\r");
    expect(late.status).toBe(409);
  });

  it("without node-pty, says why and leaves the rest of the API working", async () => {
    const test = await serveTestApi({
      loadPty: () => Promise.reject(new Error("no prebuilt binary for this platform")),
    });
    await seedTaskInReview(test.db, join(test.root, "worktrees", "alpha"));

    const read = await fetch(test.url("/api/tasks/alpha/terminal"), {
      headers: { authorization: test.authorization },
    });
    const opened = await post(test, "/api/tasks/alpha/terminal", { cols: 80, rows: 24 });
    const tasks = await fetch(test.url("/api/tasks"), {
      headers: { authorization: test.authorization },
    });

    const message =
      "Try it yourself needs node-pty, which could not be loaded: no prebuilt binary for this platform";
    expect(apiResponseSchemas.taskTerminal.parse(await read.json())).toEqual({
      available: false,
      message,
    });
    expect(opened.status).toBe(409);
    expect(apiErrorSchema.parse(await opened.json()).message).toBe(message);
    expect(tasks.status).toBe(200);
  });

  it("the kill path kills open terminals and what runs in them", async () => {
    const repo = await createTempRepo();
    await repo.git("switch", "--quiet", "--create", "dev");
    const env = await isolatedEnv();
    const { stateDir, database } = projectPaths(repo.path);
    await mkdir(stateDir, { recursive: true });
    const db = openDb(database);
    await seedTaskInReview(db, join(await makeTempDir("try-it"), "alpha"));
    db.close();

    const mastermind = spawnCli([repo.path], env.env);
    mastermind.child.stdin.end();
    const port = await waitFor(() => readLock(stateDir)?.port, 20_000).catch((error: unknown) => {
      const { stdout, stderr } = mastermind.output;
      throw new Error(`mastermind did not start:\n${stdout}${stderr}`, { cause: error });
    });
    const token = (await readFile(tokenPath(stateDir), "utf8")).trim();
    const server: Server = {
      url: (path) => `http://127.0.0.1:${String(port)}${path}`,
      authorization: `Bearer ${token}`,
    };
    const terminal = await openTerminal(server, "alpha");
    const processes = await startLongCommand(server, terminal.id);

    mastermind.child.kill("SIGINT");
    await waitFor(() => mastermind.output.stdout.includes("Press Ctrl+C again to quit."));
    mastermind.child.kill("SIGINT");

    expect(await mastermind.closed).toBe(130);
    await waitForDeath(processes);
  });
});
