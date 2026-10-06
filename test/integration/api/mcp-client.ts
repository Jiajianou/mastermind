import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mcpPath } from "@mastermind/core/contracts";
import { onCleanup } from "../../support/cleanup.js";
import type { TestApi } from "./harness.js";

export async function connect(test: TestApi, authorization = test.authorization): Promise<Client> {
  const client = new Client({ name: "mcp-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(test.url(mcpPath)), {
    requestInit: { headers: { authorization } },
  });
  await client.connect(transport);
  onCleanup(() => client.close());
  return client;
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
}

export function text(result: CallToolResult): string {
  const [block] = result.content;
  if (block?.type !== "text") throw new Error("expected a text block");
  return block.text;
}
