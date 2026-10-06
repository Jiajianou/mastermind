import type { Server } from "node:http";

export interface PortChoice {
  first: number;
  exact: boolean;
}

export class PortUnavailableError extends Error {
  override readonly name = "PortUnavailableError";
}

const fallbackAttempts = 100;
const maxPort = 65_535;

function errorCode(error: unknown): unknown {
  return error instanceof Error && "code" in error ? error.code : undefined;
}

function listenOnce(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

export async function listenOnFreePort(
  server: Server,
  { first, exact }: PortChoice,
): Promise<number> {
  const last = exact ? first : Math.min(first + fallbackAttempts - 1, maxPort);
  for (let port = first; port <= last; port += 1) {
    try {
      await listenOnce(server, port);
      return port;
    } catch (error) {
      if (errorCode(error) !== "EADDRINUSE") throw error;
    }
  }
  throw new PortUnavailableError(
    exact
      ? `port ${String(first)} is already in use`
      : `no free port from ${String(first)} to ${String(last)}`,
  );
}
