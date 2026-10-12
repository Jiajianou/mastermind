import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply } from "fastify";
import { errorMessage } from "../contracts/index.js";
import type { ActionRegistry } from "../actions/index.js";
import type { ChatState } from "../chat.js";
import { registerMcpRoutes } from "../conductor/mcp.js";
import type { Config, InstanceInfo, OwnerBranch, Summary } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { EventBus } from "../events.js";
import type { Git } from "../git/index.js";
import type { ProposalGate } from "../proposals.js";
import { createReadModels } from "../reads.js";
import type { Terminals } from "../terminals.js";
import { registerActionRoutes } from "./action-routes.js";
import { apiError, errorReply } from "./errors.js";
import { bearerRejection, siteRejection } from "./local-request.js";
import type { Rejection } from "./local-request.js";
import { registerReadRoutes } from "./read-routes.js";
import { createEventStream } from "./stream.js";
import type { Goodbye } from "./stream.js";
import { registerTerminalRoutes } from "./terminal-routes.js";

export interface ApiServerOptions {
  db: Db;
  git: Git;
  bus: EventBus;
  actions: ActionRegistry;
  gate: ProposalGate;
  chat: ChatState;
  terminals: Terminals;
  instance: InstanceInfo;
  summary: () => Summary;
  config: () => Config;
  ownerBranch: () => Promise<OwnerBranch>;
  token: string;
  webRoot: string;
  server?: Server;
  onError: (error: unknown) => void;
}

export interface ApiServer {
  app: FastifyInstance;
  server: Server;
  webClientConnected(): boolean;
  closeSync(goodbye?: Goodbye): void;
}

const pathOf = (url: string): string => url.split("?", 1)[0] ?? url;

const isApiPath = (url: string): boolean => {
  const path = pathOf(url);
  return path === "/api" || path.startsWith("/api/");
};

function sendRejection(reply: FastifyReply, rejection: Rejection | null) {
  if (rejection === null) return;
  if (rejection.status === 401) void reply.header("www-authenticate", "Bearer");
  return reply.code(rejection.status).send(rejection.body);
}

// The web app's own files carry no data, and a browser navigating to the link can't send the bearer token, so
// only the API and MCP routes need it; the Host and Origin checks apply to everything. The token hook is bound to the routes,
// not to a URL prefix, because the router matches the decoded path (/%61pi/summary reaches /api/summary).
// While a reset swaps one runtime for the next, the port stays open and every request is told to try again.
function holdDuringReset(server: Server): void {
  server.on("request", (_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
    response.end(JSON.stringify(apiError("resetting", "mastermind is resetting the project")));
  });
  server.on("upgrade", (_request: IncomingMessage, socket: Duplex) => {
    socket.destroy();
  });
}

export async function createApiServer(options: ApiServerOptions): Promise<ApiServer> {
  const { token, onError } = options;
  const server = options.server ?? createServer();
  server.removeAllListeners("request");
  server.removeAllListeners("upgrade");
  const stream = createEventStream({ bus: options.bus, token });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    stream.handleUpgrade(request, socket, head);
  };
  let onRequest: ((request: IncomingMessage, response: ServerResponse) => void) | null = null;
  const app = Fastify({
    logger: false,
    serverFactory: (handler) => {
      onRequest = handler;
      return server.on("request", handler);
    },
  });
  server.on("upgrade", onUpgrade);

  app.addHook("onRequest", async (request, reply) =>
    sendRejection(reply, siteRejection(request.headers)),
  );

  app.setErrorHandler((error: unknown, _request, reply) => {
    const known = errorReply(error);
    if (known !== null) return reply.code(known.status).send(known.body);
    onError(error);
    const message = errorMessage(error);
    return reply.code(500).send(apiError("internal", message));
  });

  const servesWebApp = existsSync(join(options.webRoot, "index.html"));
  if (servesWebApp) await app.register(fastifyStatic, { root: options.webRoot });

  app.setNotFoundHandler((request, reply) => {
    if (servesWebApp && request.method === "GET" && !isApiPath(request.url))
      return reply.sendFile("index.html");
    return reply
      .code(404)
      .send(apiError("not_found", `no route ${request.method} ${pathOf(request.url)}`));
  });

  await app.register((api, _options, done) => {
    api.addHook("onRequest", async (request, reply) =>
      sendRejection(reply, bearerRejection(request.headers.authorization, token)),
    );
    const { db, bus, actions, gate, chat } = options;
    const reads = createReadModels(options);
    registerReadRoutes(api, reads);
    registerActionRoutes(api, actions);
    registerTerminalRoutes(api, options.terminals);
    registerMcpRoutes(api, {
      actions,
      gate,
      reads,
      chat: { db, bus, activeTurn: () => chat.activeTurn() },
      onError,
    });
    done();
  });
  await app.ready();

  return {
    app,
    server,
    webClientConnected: () => stream.webClientConnected(),
    closeSync(goodbye) {
      stream.closeSync(goodbye);
      if (onRequest !== null) server.off("request", onRequest);
      server.off("upgrade", onUpgrade);
      server.closeAllConnections();
      if (goodbye === "service.resetting") holdDuringReset(server);
      else server.close();
    },
  };
}
