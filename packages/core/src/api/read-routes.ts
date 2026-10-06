import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parseInput } from "../actions/index.js";
import {
  changesQuerySchema,
  chatQuerySchema,
  fileQuerySchema,
  sessionEventsQuerySchema,
  sessionsQuerySchema,
  taskIdSchema,
} from "../contracts/index.js";
import type {
  ApiSummary,
  ChatView,
  Check,
  CheckLog,
  Comment,
  Config,
  FileContent,
  Finding,
  InstanceInfo,
  OwnerBranch,
  ReviewNotes,
  Round,
  Session,
  SessionEvent,
  TaskChanges,
  TaskTree,
  TaskView,
} from "../contracts/index.js";
import type { ReadModels } from "../reads.js";

const taskParamsSchema = z.strictObject({ taskId: taskIdSchema });
const sessionParamsSchema = z.strictObject({ sessionId: z.coerce.number().int().min(1) });
const checkParamsSchema = z.strictObject({ checkId: z.coerce.number().int().min(1) });

export function registerReadRoutes(app: FastifyInstance, reads: ReadModels): void {
  app.get("/api/instance", (): InstanceInfo => reads.instance());

  app.get("/api/summary", (): ApiSummary => reads.summary());

  app.get("/api/tasks", (): TaskView[] => reads.tasks());

  app.get("/api/branch", (): Promise<OwnerBranch> => reads.ownerBranch());

  app.get("/api/tasks/:taskId", (request): TaskView => {
    const { taskId } = parseInput(taskParamsSchema, request.params);
    return reads.task(taskId);
  });

  app.get("/api/tasks/:taskId/changes", (request): Promise<TaskChanges> => {
    const { taskId } = parseInput(taskParamsSchema, request.params);
    const { since } = parseInput(changesQuerySchema, request.query);
    return reads.changes({ taskId, since });
  });

  app.get("/api/tasks/:taskId/file", (request): Promise<FileContent> => {
    const { taskId } = parseInput(taskParamsSchema, request.params);
    return reads.file(taskId, parseInput(fileQuerySchema, request.query));
  });

  app.get("/api/tasks/:taskId/tree", (request): Promise<TaskTree> => {
    const { taskId } = parseInput(taskParamsSchema, request.params);
    return reads.tree(taskId);
  });

  app.get("/api/tasks/:taskId/checks", (request): Check[] => {
    const { taskId } = parseInput(taskParamsSchema, request.params);
    return reads.checks(taskId);
  });

  app.get("/api/tasks/:taskId/comments", (request): Comment[] => {
    const { taskId } = parseInput(taskParamsSchema, request.params);
    return reads.comments(taskId);
  });

  app.get("/api/tasks/:taskId/findings", (request): Finding[] => {
    const { taskId } = parseInput(taskParamsSchema, request.params);
    return reads.findings(taskId);
  });

  app.get("/api/tasks/:taskId/rounds", (request): Round[] => {
    const { taskId } = parseInput(taskParamsSchema, request.params);
    return reads.rounds(taskId);
  });

  app.get("/api/tasks/:taskId/notes", (request): ReviewNotes => {
    const { taskId } = parseInput(taskParamsSchema, request.params);
    return reads.reviewNotes(taskId);
  });

  app.get("/api/checks/:checkId/log", (request): Promise<CheckLog> => {
    const { checkId } = parseInput(checkParamsSchema, request.params);
    return reads.checkLog(checkId);
  });

  app.get("/api/sessions", (request): Session[] =>
    reads.sessions(parseInput(sessionsQuerySchema, request.query)),
  );

  app.get("/api/sessions/:sessionId/events", (request): SessionEvent[] => {
    const { sessionId } = parseInput(sessionParamsSchema, request.params);
    const { after } = parseInput(sessionEventsQuerySchema, request.query);
    return reads.sessionEvents(sessionId, after);
  });

  app.get("/api/chat", (request): ChatView => {
    const { after } = parseInput(chatQuerySchema, request.query);
    return reads.chat(after);
  });

  app.get("/api/config", (): Config => reads.config());
}
