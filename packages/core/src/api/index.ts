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

export interface ServeApiOptions extends Omit<ApiServerOptions, "token"> {
  stateDir: string;
  lock: Pick<InstanceLock, "setPort">;
  port: PortChoice;
}

export interface ServedApi extends ApiServer {
  port: number;
  token: string;
  link: string;
}

export async function serveApi(options: ServeApiOptions): Promise<ServedApi> {
  const token = createToken();
  writeTokenFile(options.stateDir, token);
  const api = await createApiServer({ ...options, token });
  try {
    const port = await listenOnFreePort(api.server, options.port);
    options.lock.setPort(port);
    return { ...api, port, token, link: webAppLink(port, token) };
  } catch (error) {
    api.closeSync();
    throw error;
  }
}
