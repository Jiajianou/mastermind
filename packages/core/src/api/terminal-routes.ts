import type { FastifyInstance } from "fastify";
import { parseInput } from "../actions/index.js";
import {
  taskTerminalParamsSchema,
  terminalInputSchema,
  terminalParamsSchema,
  terminalSizeSchema,
} from "../contracts/index.js";
import type { TaskTerminal, Terminal, TerminalView } from "../contracts/index.js";
import type { Terminals } from "../terminals.js";

// Plain routes rather than actions: a shell is for the owner only and must never become a Conductor tool.
export function registerTerminalRoutes(app: FastifyInstance, terminals: Terminals): void {
  app.get("/api/tasks/:taskId/terminal", (request): Promise<TaskTerminal> => {
    const { taskId } = parseInput(taskTerminalParamsSchema, request.params);
    return terminals.read(taskId);
  });

  app.post("/api/tasks/:taskId/terminal", (request): Promise<TerminalView> => {
    const { taskId } = parseInput(taskTerminalParamsSchema, request.params);
    return terminals.open(taskId, parseInput(terminalSizeSchema, request.body));
  });

  app.post("/api/terminals/:terminalId/input", (request): Terminal => {
    const { terminalId } = parseInput(terminalParamsSchema, request.params);
    return terminals.write(terminalId, parseInput(terminalInputSchema, request.body).data);
  });

  app.post("/api/terminals/:terminalId/resize", (request): Terminal => {
    const { terminalId } = parseInput(terminalParamsSchema, request.params);
    return terminals.resize(terminalId, parseInput(terminalSizeSchema, request.body));
  });

  app.post("/api/terminals/:terminalId/stop", (request): Promise<Terminal> => {
    const { terminalId } = parseInput(terminalParamsSchema, request.params);
    return terminals.stop(terminalId);
  });
}
