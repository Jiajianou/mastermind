import type { Server } from "node:http";
import { webAppLink } from "../lock.js";
import type { InstanceLock } from "../lock.js";
import { listenOnFreePort } from "./listen.js";
import type { PortChoice } from "./listen.js";
import { createApiServer } from "./server.js";
import type { ApiServer, ApiServerOptions } from "./server.js";
import { createToken, writeTokenFile } from "./token.js";

export { PortUnavailableError } from "./listen.js";
export type { PortChoice } from "./listen.js";
export { createApiServer } from "./server.js";
export type { ApiServer, ApiServerOptions } from "./server.js";
export type { Goodbye } from "./stream.js";

export interface ServeApiOptions extends Omit<ApiServerOptions, "token"> {
  stateDir: string;
  token?: string;
  lock: Pick<InstanceLock, "setPort">;
  port: PortChoice;
}

export interface ServedApi extends ApiServer {
  port: number;
  token: string;
  link: string;
}

function listeningPort(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("the API server handed over by a reset is not listening on a port");
  return address.port;
}

export async function serveApi(options: ServeApiOptions): Promise<ServedApi> {
  const token = options.token ?? createToken();
  writeTokenFile(options.stateDir, token);
  const api = await createApiServer({ ...options, token });
  if (options.server !== undefined) {
    const port = listeningPort(options.server);
    return { ...api, port, token, link: webAppLink(port, token) };
  }
  try {
    const port = await listenOnFreePort(api.server, options.port);
    options.lock.setPort(port);
    return { ...api, port, token, link: webAppLink(port, token) };
  } catch (error) {
    api.closeSync();
    throw error;
  }
}
