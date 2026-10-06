import type { StreamMessage } from "@mastermind/core/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import { session, snapshot, summary, task } from "../testing/fixtures.js";
import { createStore } from "../store/store.js";
import { connectLive } from "./connection.js";

const token = "8f3c2a91".repeat(8);
const served = snapshot();

class FakeSocket extends EventTarget {
  closed = false;

  open(): void {
    this.dispatchEvent(new Event("open"));
  }

  receive(message: StreamMessage): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  close(): void {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
}

type Reply = () => Response | Promise<Response>;

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

const healthyServer: Record<string, Reply> = {
  "/api/instance": () => json(served.instance),
  "/api/summary": () => json(served.summary),
  "/api/tasks": () => json([task("alpha")]),
  "/api/sessions": () => json([]),
  "/api/chat": () => json(served.chat),
};

const authorizations: (string | null)[] = [];

function serve(replies: Record<string, Reply>): void {
  vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
    authorizations.push(new Headers(init.headers).get("authorization"));
    const reply = replies[new URL(path, "http://mastermind").pathname];
    return reply === undefined ? Promise.reject(new TypeError("fetch failed")) : reply();
  });
}

const flushPromises = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  authorizations.length = 0;
  vi.unstubAllGlobals();
});

function connect() {
  const store = createStore();
  const sockets: FakeSocket[] = [];
  stops.push(
    connectLive({
      store,
      api: createApiClient(token),
      retryDelaysMs: [1, 1],
      openSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    }),
  );
  const nextSocket = (count: number) =>
    vi.waitFor(() => {
      const socket = sockets[count - 1];
      if (socket === undefined) throw new Error(`socket ${String(count)} not opened yet`);
      return socket;
    });
  const connection = (expected: string) =>
    vi.waitFor(() => {
      expect(store.getState().connection).toBe(expected);
    });
  return { store, sockets, nextSocket, connection };
}

describe("live connection", () => {
  it("applies events that arrive while the snapshot loads on top of the snapshot", async () => {
    let releaseTasks = (): void => undefined;
    const tasksRead = new Promise<Response>((resolve) => {
      releaseTasks = () => {
        resolve(json([task("alpha")]));
      };
    });
    serve({ ...healthyServer, "/api/tasks": () => tasksRead });
    const { store, nextSocket, connection } = connect();

    const socket = await nextSocket(1);
    socket.open();
    const running = task("alpha", { status: "running", updatedAt: new Date().toISOString() });
    socket.receive({ type: "task.updated", taskId: "alpha", task: running });
    socket.receive({ type: "session.started", sessionId: 1, taskId: "alpha", session: session(1) });
    releaseTasks();

    await connection("live");
    expect(store.getState().tasks.alpha).toEqual(running);
    expect(store.getState().sessions[1]).toEqual(session(1));
    expect(store.getState().instance).toEqual(served.instance);
    expect(new Set(authorizations)).toEqual(new Set([`Bearer ${token}`]));
  });

  it("ignores a snapshot that fails after its socket already dropped", async () => {
    let failFirstTasksRead = (): void => undefined;
    const firstTasksRead = new Promise<Response>((_resolve, reject) => {
      failFirstTasksRead = () => {
        reject(new TypeError("fetch failed"));
      };
    });
    let tasksReads = 0;
    serve({
      ...healthyServer,
      "/api/tasks": () => (tasksReads++ === 0 ? firstTasksRead : json([task("alpha")])),
    });
    const { sockets, nextSocket, connection } = connect();
    const first = await nextSocket(1);
    first.open();
    first.close();
    const second = await nextSocket(2);
    second.open();
    await connection("live");

    failFirstTasksRead();
    await flushPromises();

    expect(second.closed).toBe(false);
    expect(sockets).toHaveLength(2);
  });

  it("shows no access and stops trying when mastermind refuses the token", async () => {
    serve({ ...healthyServer, "/api/instance": () => json({}, 401) });
    const { sockets, connection } = connect();

    await connection("unauthorized");
    expect(sockets).toHaveLength(0);
  });

  it("shows stopped at once when mastermind says it is stopping", async () => {
    serve(healthyServer);
    const { sockets, nextSocket, connection } = connect();
    const socket = await nextSocket(1);
    socket.open();
    await connection("live");

    socket.receive({ type: "service.stopping" });

    expect(sockets).toHaveLength(1);
    await connection("stopped");
  });

  it("reconnects after a dropped socket and shows stopped once every retry fails", async () => {
    serve({ ...healthyServer, "/api/summary": () => json(summary({ paused: true })) });
    const { store, nextSocket, connection } = connect();
    (await nextSocket(1)).open();
    await connection("live");

    (await nextSocket(1)).close();
    expect(store.getState().connection).toBe("reconnecting");
    (await nextSocket(2)).open();
    await connection("live");
    expect(store.getState().scheduler.paused).toBe(true);

    serve({});
    (await nextSocket(2)).close();

    await connection("stopped");
  });
});
