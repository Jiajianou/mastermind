import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mcpPath } from "../contracts/index.js";

export interface McpEndpoint {
  port: number;
  token: string;
}

export function conductorMcpConfigPath(stateDir: string): string {
  return join(stateDir, "run", "conductor-mcp.json");
}

export async function writeConductorMcpConfig(
  path: string,
  { port, token }: McpEndpoint,
): Promise<void> {
  const config = {
    mcpServers: {
      mastermind: {
        type: "http",
        url: `http://127.0.0.1:${String(port)}${mcpPath}`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
  const temp = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temp, path);
}
