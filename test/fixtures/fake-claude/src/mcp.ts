import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { CliError } from "./errors.js";
import type { McpServerStatus, ToolUseMeta } from "./lines.js";

const httpServerSchema = z.looseObject({
  type: z.literal("http"),
  url: z.url(),
  headers: z.record(z.string(), z.string()).optional(),
});
type HttpServer = z.infer<typeof httpServerSchema>;

const mcpConfigSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.looseObject({ type: z.string() })),
});

const rpcResponseSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: z.number(),
  result: z.unknown().optional(),
  error: z.looseObject({ message: z.string() }).optional(),
});

const initializeSchema = z.looseObject({
  serverInfo: z.looseObject({ name: z.string() }).optional(),
});

const toolListSchema = z.looseObject({
  tools: z.array(z.looseObject({ name: z.string(), title: z.string().optional() })),
});

const toolCallSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string() })),
  isError: z.boolean().optional(),
});
export type ToolCallResult = z.infer<typeof toolCallSchema>;

function readConfigSource(source: string): unknown {
  const text = existsSync(source) ? readFileSync(source, "utf8") : source;
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`Error: Invalid MCP configuration: ${source} is neither a file nor JSON`);
  }
}

function parseServers(sources: readonly string[]): Map<string, unknown> {
  const servers = new Map<string, unknown>();
  for (const source of sources) {
    const parsed = mcpConfigSchema.safeParse(readConfigSource(source));
    if (!parsed.success) throw new CliError(`Error: Invalid MCP configuration in ${source}`);
    for (const [name, server] of Object.entries(parsed.data.mcpServers)) servers.set(name, server);
  }
  return servers;
}

class McpConnection {
  private nextId = 1;
  private sessionHeader: string | undefined;

  constructor(private readonly server: HttpServer) {}

  async request(method: string, params: object): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params });
    const body = await readRpcBody(response);
    const parsed = rpcResponseSchema.parse(body);
    if (parsed.error !== undefined)
      throw new Error(`MCP ${method} failed: ${parsed.error.message}`);
    return parsed.result;
  }

  async notify(method: string): Promise<void> {
    const response = await this.post({ jsonrpc: "2.0", method });
    await response.body?.cancel();
  }

  private async post(message: object): Promise<Response> {
    const response = await fetch(this.server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...this.server.headers,
        ...(this.sessionHeader === undefined ? {} : { "mcp-session-id": this.sessionHeader }),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`MCP server answered HTTP ${String(response.status)}`);
    this.sessionHeader = response.headers.get("mcp-session-id") ?? this.sessionHeader;
    return response;
  }
}

async function readRpcBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream"))
    return JSON.parse(text);
  const data = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim());
  const last = data.at(-1);
  if (last === undefined) throw new Error("MCP server sent an empty event stream");
  return JSON.parse(last);
}

function titleCase(toolName: string): string {
  return toolName
    .split(/[_-]+/)
    .filter((word) => word !== "")
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function failedCall(text: string): ToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

export interface McpClients {
  statuses: McpServerStatus[];
  toolNames: string[];
  toolMeta(server: string, tool: string): ToolUseMeta | undefined;
  callTool(server: string, tool: string, args: Record<string, unknown>): Promise<ToolCallResult>;
}

export async function connectMcpServers(
  sources: readonly string[],
  version: string,
): Promise<McpClients> {
  const connections = new Map<string, McpConnection>();
  const statuses: McpServerStatus[] = [];
  const toolNames: string[] = [];
  const metas = new Map<string, ToolUseMeta>();

  for (const [name, config] of parseServers(sources)) {
    const server = httpServerSchema.safeParse(config);
    if (!server.success) {
      statuses.push({ name, status: "failed", source: "dynamic" });
      continue;
    }
    const connection = new McpConnection(server.data);
    try {
      const initialized = initializeSchema.parse(
        await connection.request("initialize", {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "claude-code", version },
        }),
      );
      await connection.notify("notifications/initialized");
      const listed = toolListSchema.parse(await connection.request("tools/list", {}));
      const serverDisplayName = initialized.serverInfo?.name ?? name;
      for (const tool of listed.tools) {
        const fullName = `mcp__${name}__${tool.name}`;
        toolNames.push(fullName);
        metas.set(fullName, {
          displayName: tool.title ?? titleCase(tool.name),
          serverDisplayName,
        });
      }
      connections.set(name, connection);
      statuses.push({ name, status: "connected", source: "dynamic" });
    } catch (error) {
      process.stderr.write(`fake-claude: MCP server ${name} failed: ${String(error)}\n`);
      statuses.push({ name, status: "failed", source: "dynamic" });
    }
  }

  return {
    statuses,
    toolNames,
    toolMeta: (server, tool) => metas.get(`mcp__${server}__${tool}`),
    async callTool(server, tool, args) {
      const connection = connections.get(server);
      if (connection === undefined) {
        return failedCall(`Error: No such tool available: mcp__${server}__${tool}`);
      }
      try {
        return toolCallSchema.parse(
          await connection.request("tools/call", { name: tool, arguments: args }),
        );
      } catch (error) {
        return failedCall(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
