import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ActionError, parseInput } from "../actions/index.js";
import { sessionEventsQuerySchema, sessionsQuerySchema, taskIdSchema } from "../contracts/index.js";
import type {
  ApiSummary,
  Session,
  SessionEvent,
  Summary,
  Task,
  TaskView,
} from "../contracts/index.js";
import type { Db } from "../db/index.js";

export interface ReadSources {
  db: Db;
  summary: () => Summary;
}

const taskParamsSchema = z.strictObject({ taskId: taskIdSchema });
const sessionParamsSchema = z.strictObject({ sessionId: z.coerce.number().int().min(1) });

function taskViews(tasks: readonly Task[]): TaskView[] {
  const unblocks = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.deps) unblocks.set(dep, [...(unblocks.get(dep) ?? []), task.id]);
  }
  return tasks.map((task) => ({ ...task, unblocks: unblocks.get(task.id) ?? [] }));
}

function readSummary({ db, summary }: ReadSources): ApiSummary {
  const rebaseQueue = db.tasks
    .list()
    .filter((task) => task.status === "rebasing")
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .map((task) => task.id);
  return { ...summary(), activeSessions: db.sessions.listRunning(), rebaseQueue };
}

function requireSession(db: Db, sessionId: number): Session {
  const session = db.sessions.get(sessionId);
  if (session === null)
    throw ActionError.fromMessage("not_found", `no session ${String(sessionId)}`);
  return session;
}

export function registerReadRoutes(app: FastifyInstance, sources: ReadSources): void {
  const { db } = sources;

  app.get("/api/summary", (): ApiSummary => readSummary(sources));

  app.get("/api/tasks", (): TaskView[] => taskViews(db.tasks.list()));

  app.get("/api/tasks/:taskId", (request): TaskView => {
    const { taskId } = parseInput(taskParamsSchema, request.params);
    const task = taskViews(db.tasks.list()).find((view) => view.id === taskId);
    if (task === undefined) throw ActionError.fromMessage("not_found", `no task "${taskId}"`);
    return task;
  });

  app.get("/api/sessions", (request): Session[] => {
    const { taskId, since } = parseInput(sessionsQuerySchema, request.query);
    const startedSince = since === undefined ? undefined : new Date(since).toISOString();
    return db.sessions.list({ taskId, startedSince });
  });

  app.get("/api/sessions/:sessionId/events", (request): SessionEvent[] => {
    const { sessionId } = parseInput(sessionParamsSchema, request.params);
    const { after } = parseInput(sessionEventsQuerySchema, request.query);
    requireSession(db, sessionId);
    return db.events.listForSession(sessionId, { afterId: after });
  });
}
