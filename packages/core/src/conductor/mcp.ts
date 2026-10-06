import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import { apiError, errorReply } from "../api/errors.js";
import { errorMessage, mcpPath } from "../contracts/index.js";
import { conductorTools } from "./tools.js";
import type { ConductorTool, ToolSources } from "./tools.js";

export interface McpOptions extends ToolSources {
  onError: (error: unknown) => void;
}

const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(isError ? { isError } : {}),
});

async function callTool(
  tool: ConductorTool,
  input: unknown,
  onError: (error: unknown) => void,
): Promise<CallToolResult> {
  try {
    const result = await tool.call(input);
    return textResult(result === undefined ? "null" : JSON.stringify(result));
  } catch (error) {
    const known = errorReply(error);
    if (known !== null) return textResult(known.body.message, true);
    onError(error);
    const message = errorMessage(error);
    return textResult(`internal error: ${message}`, true);
  }
}

export function createMcpServer(options: McpOptions): McpServer {
  const server = new McpServer({ name: "mastermind", version: "0.0.0" });
  for (const tool of conductorTools(options)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input },
      (input) => callTool(tool, input, options.onError),
    );
  }
  return server;
}

// Stateless: every POST gets its own server and transport, so the tool list and descriptions always follow the
// current config (a change to conductor.confirm shows on the next request), and nothing outlives the request.
export function registerMcpRoutes(app: FastifyInstance, options: McpOptions): void {
  app.post(mcpPath, async (request, reply) => {
    const server = createMcpServer(options);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    reply.raw.on("close", () => {
      server.close().catch(options.onError);
    });
    await server.connect(transport);
    reply.hijack();
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      options.onError(error);
      if (!reply.raw.headersSent) {
        const message = errorMessage(error);
        reply.raw
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify(apiError("internal", message)));
      }
    }
  });

  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: mcpPath,
      handler: (_request, reply) =>
        reply
          .code(405)
          .header("allow", "POST")
          .send(apiError("invalid_input", `${method} is not supported on ${mcpPath}; use POST`)),
    });
  }
}
