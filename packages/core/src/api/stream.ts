import type { IncomingMessage } from "node:http";
import { STATUS_CODES } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { streamPath, streamProtocol, webClientProtocol } from "../contracts/index.js";
import type { StreamMessage } from "../contracts/index.js";
import type { EventBus } from "../events.js";
import { apiError } from "./errors.js";
import type { ErrorReply } from "./errors.js";
import { offeredProtocols, siteRejection, streamRejection } from "./local-request.js";

export interface EventStream {
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  webClientConnected(): boolean;
  closeSync(): void;
}

export interface EventStreamOptions {
  bus: EventBus;
  token: string;
}

const goingAway = 1001;

function upgradeRejection(request: IncomingMessage, token: string): ErrorReply | null {
  const path = (request.url ?? "").split("?", 1)[0];
  if (path !== streamPath)
    return { status: 404, body: apiError("not_found", `no WebSocket at ${path ?? ""}`) };
  return (
    siteRejection(request.headers) ??
    streamRejection(request.headers["sec-websocket-protocol"], token)
  );
}

function refuse(socket: Duplex, { status, body }: ErrorReply): void {
  const content = JSON.stringify(body);
  socket.once("error", () => {
    socket.destroy();
  });
  socket.end(
    [
      `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ""}`,
      "Connection: close",
      "Content-Type: application/json; charset=utf-8",
      `Content-Length: ${String(Buffer.byteLength(content))}`,
      "",
      content,
    ].join("\r\n"),
  );
}

export function createEventStream({ bus, token }: EventStreamOptions): EventStream {
  const server = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: () => streamProtocol,
  });
  const webClients = new Set<WebSocket>();

  function send(client: WebSocket, data: string): void {
    if (client.readyState !== WebSocket.OPEN) return;
    client.send(data, (error) => {
      if (error instanceof Error) client.terminate();
    });
  }

  function broadcast(message: StreamMessage): void {
    const data = JSON.stringify(message);
    for (const client of server.clients) send(client, data);
  }

  server.on("connection", (client) => {
    // A broken client connection only ends that client; the stream carries on for the others.
    client.on("error", () => {
      client.terminate();
    });
  });

  const unsubscribe = bus.subscribe(broadcast);

  return {
    handleUpgrade(request, socket, head) {
      const rejection = upgradeRejection(request, token);
      if (rejection !== null) {
        refuse(socket, rejection);
        return;
      }
      const fromWebApp = offeredProtocols(request.headers["sec-websocket-protocol"]).includes(
        webClientProtocol,
      );
      server.handleUpgrade(request, socket, head, (client) => {
        if (fromWebApp) {
          webClients.add(client);
          client.once("close", () => {
            webClients.delete(client);
          });
        }
        server.emit("connection", client, request);
      });
    },

    webClientConnected: () =>
      [...webClients].some((client) => client.readyState === WebSocket.OPEN),

    // The kill path can't wait, so the goodbye is written synchronously and may not arrive.
    closeSync() {
      unsubscribe();
      broadcast({ type: "service.stopping" });
      for (const client of server.clients) {
        client.close(goingAway, "mastermind stopped");
        client.terminate();
      }
      server.close();
    },
  };
}
