import { once } from "node:events";
import { streamMessageSchema, streamPath, streamProtocols } from "@mastermind/core/contracts";
import type { StreamMessage } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { onCleanup } from "../../support/cleanup.js";
import { waitFor } from "../../support/processes.js";
import { serveTestApi } from "./harness.js";
import type { TestApi } from "./harness.js";

interface StreamClient {
  socket: WebSocket;
  messages: StreamMessage[];
  closeCode: Promise<number>;
}

interface Offer {
  protocols?: string[];
  origin?: string;
  path?: string;
}

function open(test: TestApi, { protocols, origin, path = streamPath }: Offer): WebSocket {
  const socket = new WebSocket(
    test.url(path).replace("http:", "ws:"),
    protocols ?? streamProtocols(test.api.token),
    origin === undefined ? {} : { origin },
  );
  onCleanup(() => {
    socket.terminate();
  });
  return socket;
}

async function connect(test: TestApi): Promise<StreamClient> {
  const socket = open(test, {});
  const messages: StreamMessage[] = [];
  socket.on("message", (data: Buffer) => {
    messages.push(streamMessageSchema.parse(JSON.parse(data.toString("utf8"))));
  });
  const closeCode = once(socket, "close").then(([code]: unknown[]) => Number(code));
  await once(socket, "open");
  return { socket, messages, closeCode };
}

async function refusal(test: TestApi, offer: Offer): Promise<string> {
  const [error] = await once(open(test, offer), "error").catch((reason: unknown) => [reason]);
  return error instanceof Error ? error.message : String(error);
}

describe("WebSocket stream", () => {
  it("delivers the events of a mutation made over HTTP, with the task id", async () => {
    const test = await serveTestApi();
    const client = await connect(test);
    const post = async (path: string, body?: unknown) => {
      const response = await fetch(test.url(path), {
        method: "POST",
        headers: {
          authorization: test.authorization,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.status).toBe(200);
    };

    await post("/api/tasks", {
      tasks: [
        { id: "alpha", title: "Alpha", goal: "Build alpha.", acceptance: "true", touches: [] },
      ],
    });
    await post("/api/tasks/alpha/hold");
    await post("/api/pause");

    await waitFor(() => client.messages.length >= 3);
    expect(
      client.messages.map((message) =>
        message.type === "task.updated"
          ? { type: message.type, taskId: message.taskId, held: message.task.held }
          : message,
      ),
    ).toEqual([
      { type: "task.updated", taskId: "alpha", held: false },
      { type: "task.updated", taskId: "alpha", held: true },
      { type: "scheduler.updated", paused: true, resumeAt: null },
    ]);
  });

  it.each([
    { case: "no token", offer: () => ({ protocols: ["mastermind"] }), status: 401 },
    {
      case: "a wrong token",
      offer: () => ({ protocols: streamProtocols("0".repeat(64)) }),
      status: 401,
    },
    {
      case: "the token without the stream protocol",
      offer: (token: string) => ({ protocols: [streamProtocols(token)[1]] }),
      status: 401,
    },
    { case: "a foreign origin", offer: () => ({ origin: "http://evil.example" }), status: 403 },
    { case: "another path", offer: () => ({ path: "/api/other" }), status: 404 },
  ])("refuses a connection with $case", async ({ offer, status }) => {
    const test = await serveTestApi();

    expect(await refusal(test, offer(test.api.token))).toBe(
      `Unexpected server response: ${String(status)}`,
    );
  });

  it("tells connected clients that mastermind is stopping when the server closes", async () => {
    const test = await serveTestApi();
    const client = await connect(test);

    test.api.closeSync();

    expect(await client.closeCode).toBe(1001);
    expect(client.messages).toEqual([{ type: "service.stopping" }]);
  });
});
