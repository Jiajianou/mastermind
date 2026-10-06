import { streamMessageSchema } from "@mastermind/core/contracts";
import type { InstanceInfo, StreamMessage } from "@mastermind/core/contracts";
import { UnauthorizedError } from "../api/client.js";
import type { ApiClient } from "../api/client.js";
import type { Snapshot } from "../store/state.js";
import type { Store } from "../store/store.js";

export type LiveSocket = Pick<WebSocket, "addEventListener" | "close">;

export interface LiveConnectionOptions {
  store: Store;
  api: ApiClient;
  openSocket: () => LiveSocket;
  retryDelaysMs?: readonly number[];
}

export const defaultRetryDelaysMs = [250, 500, 1_000, 2_000, 4_000];

function startOfToday(): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today.toISOString();
}

async function loadSnapshot(api: ApiClient, instance: InstanceInfo): Promise<Snapshot> {
  const [summary, tasks, sessions, chat, config] = await Promise.all([
    api.read("summary"),
    api.read("tasks"),
    api.read("sessions", { since: startOfToday() }),
    api.read("chat"),
    api.read("config"),
  ]);
  return { instance, summary, tasks, sessions, chat, config };
}

function parseMessage(data: unknown): StreamMessage | null {
  try {
    const parsed = streamMessageSchema.safeParse(JSON.parse(String(data)));
    if (parsed.success) return parsed.data;
    console.error("mastermind sent an unexpected stream message", parsed.error);
  } catch (error) {
    console.error("mastermind sent a stream message that is not JSON", error);
  }
  return null;
}

// The token is checked over HTTP before each socket opens, because a browser reports a refused WebSocket upgrade
// as a bare close and a wrong token would look like a server that is gone. Events that arrive while the snapshot
// loads are held and applied after it, so the snapshot never overwrites something newer.
export function connectLive({
  store,
  api,
  openSocket,
  retryDelaysMs = defaultRetryDelaysMs,
}: LiveConnectionOptions): () => void {
  let failures = 0;
  let ended = false;
  let wasLive = false;
  let socket: LiveSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const end = (connection: "stopped" | "unauthorized") => {
    ended = true;
    store.dispatch({ type: "connection.changed", connection });
    socket?.close();
  };

  const retry = () => {
    if (ended) return;
    const delay = retryDelaysMs[failures];
    failures += 1;
    if (delay === undefined) {
      end("stopped");
      return;
    }
    store.dispatch({ type: "connection.changed", connection: "reconnecting" });
    retryTimer = setTimeout(() => void connect(), delay);
  };

  // Each run has its own token, so a refusal after this page was live means that run stopped and another one
  // (possibly on the same port) answered.
  const fail = (error: unknown) => {
    if (error instanceof UnauthorizedError) {
      end(wasLive ? "stopped" : "unauthorized");
      return;
    }
    console.error("lost the connection to mastermind", error);
    if (socket === null) retry();
    else socket.close();
  };

  const listen = (instance: InstanceInfo) => {
    const current = openSocket();
    socket = current;
    let held: StreamMessage[] | null = [];

    current.addEventListener("message", ({ data }: MessageEvent) => {
      const message = parseMessage(data);
      if (message === null) return;
      if (message.type === "service.stopping") end("stopped");
      else if (held === null) store.dispatch(message);
      else held.push(message);
    });

    current.addEventListener("open", () => {
      loadSnapshot(api, instance).then(
        (snapshot) => {
          if (socket !== current || ended) return;
          store.dispatch({ type: "snapshot.loaded", snapshot });
          for (const message of held ?? []) store.dispatch(message);
          held = null;
          failures = 0;
          wasLive = true;
          store.dispatch({ type: "connection.changed", connection: "live" });
        },
        (error: unknown) => {
          if (socket === current) fail(error);
        },
      );
    });

    current.addEventListener("close", () => {
      if (socket !== current) return;
      socket = null;
      retry();
    });
  };

  const connect = async () => {
    retryTimer = null;
    let instance: InstanceInfo;
    try {
      instance = await api.read("instance");
    } catch (error) {
      fail(error);
      return;
    }
    if (!ended) listen(instance);
  };

  void connect();

  return () => {
    ended = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    socket?.close();
  };
}
