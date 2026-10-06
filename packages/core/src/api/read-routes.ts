import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseInput } from "../actions/index.js";
import { sessionEventsQuerySchema, sessionsQuerySchema, taskIdSchema } from "../contracts/index.js";
import type { ApiSummary, Session, SessionEvent, TaskView } from "../contracts/index.js";
import type { ReadModels } from "../reads.js";

const taskParamsSchema = z.strictObject({ taskId: taskIdSchema });
const sessionParamsSchema = z.strictObject({ sessionId: z.coerce.number().int().min(1) });

export function registerReadRoutes(app: FastifyInstance, reads: ReadModels): void {
  app.get("/api/summary", (): ApiSummary => reads.summary());

  app.get("/api/tasks", (): TaskView[] => reads.tasks());

  app.get("/api/tasks/:taskId", (request): TaskView => {
    const { taskId } = parseInput(taskParamsSchema, request.params);
    return reads.task(taskId);
  });

  app.get("/api/sessions", (request): Session[] =>
    reads.sessions(parseInput(sessionsQuerySchema, request.query)),
  );

  app.get("/api/sessions/:sessionId/events", (request): SessionEvent[] => {
    const { sessionId } = parseInput(sessionParamsSchema, request.params);
    const { after } = parseInput(sessionEventsQuerySchema, request.query);
    return reads.sessionEvents(sessionId, after);
  });
}
