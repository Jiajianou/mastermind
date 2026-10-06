import { z } from "zod";
import { actionErrorCodeSchema, actionIssueSchema } from "./actions.js";
import { chatViewSchema } from "./chat.js";
import type { ChatTurn, Proposal } from "./chat.js";
import { isoTimestampSchema } from "./common.js";
import type { Config } from "./config.js";
import { busEventSchema } from "./events.js";
import { summarySchema } from "./runtime.js";
import type { RuntimeFlags } from "./runtime.js";
import { sessionEventSchema, sessionSchema } from "./sessions.js";
import type { Session } from "./sessions.js";
import { taskIdSchema, taskSchema } from "./tasks.js";
import type { Task } from "./tasks.js";

export const apiErrorCodeSchema = z.enum([
  ...actionErrorCodeSchema.options,
  "unauthorized",
  "forbidden",
  "internal",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string(),
  issues: z.array(actionIssueSchema),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export interface ActionResults {
  createTasks: Task[];
  importTasks: { tasks: Task[]; warnings: string[] };
  exportTasks: { yaml: string };
  updateTask: Task;
  setPriority: Task;
  moveToTop: Task;
  hold: Task;
  release: Task;
  retry: Task;
  stopSession: Session;
  pause: RuntimeFlags;
  resume: RuntimeFlags;
  setConfig: Config;
  confirmProposal: Proposal;
  rejectProposal: Proposal;
  sendChat: ChatTurn;
  stopChat: { stopped: boolean };
}
export type ActionName = keyof ActionResults;

export interface ActionRoute {
  method: "POST" | "PATCH";
  path: string;
  intParams?: readonly string[];
}

// Path parameters carry the action's input fields of the same name; the JSON body carries the rest.
export const actionRoutes = {
  createTasks: { method: "POST", path: "/api/tasks" },
  importTasks: { method: "POST", path: "/api/tasks/import" },
  exportTasks: { method: "POST", path: "/api/tasks/export" },
  updateTask: { method: "PATCH", path: "/api/tasks/:taskId" },
  setPriority: { method: "POST", path: "/api/tasks/:taskId/priority" },
  moveToTop: { method: "POST", path: "/api/tasks/:taskId/top" },
  hold: { method: "POST", path: "/api/tasks/:taskId/hold" },
  release: { method: "POST", path: "/api/tasks/:taskId/release" },
  retry: { method: "POST", path: "/api/tasks/:taskId/retry" },
  stopSession: {
    method: "POST",
    path: "/api/sessions/:sessionId/stop",
    intParams: ["sessionId"],
  },
  pause: { method: "POST", path: "/api/pause" },
  resume: { method: "POST", path: "/api/resume" },
  setConfig: { method: "PATCH", path: "/api/config" },
  confirmProposal: {
    method: "POST",
    path: "/api/proposals/:proposalId/confirm",
    intParams: ["proposalId"],
  },
  rejectProposal: {
    method: "POST",
    path: "/api/proposals/:proposalId/reject",
    intParams: ["proposalId"],
  },
  sendChat: { method: "POST", path: "/api/chat" },
  stopChat: { method: "POST", path: "/api/chat/stop" },
} as const satisfies Record<ActionName, ActionRoute>;

export function isActionName(name: string): name is ActionName {
  return Object.hasOwn(actionRoutes, name);
}

export const apiSummarySchema = summarySchema.extend({
  activeSessions: z.array(sessionSchema),
  rebaseQueue: z.array(z.string()),
});
export type ApiSummary = z.infer<typeof apiSummarySchema>;

export const taskViewSchema = taskSchema.extend({ unblocks: z.array(z.string()) });
export type TaskView = z.infer<typeof taskViewSchema>;

export const sessionsQuerySchema = z.strictObject({
  taskId: taskIdSchema.optional(),
  since: isoTimestampSchema.optional(),
});
export type SessionsQuery = z.infer<typeof sessionsQuerySchema>;

export const sessionEventsQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).optional(),
});
export type SessionEventsQuery = z.infer<typeof sessionEventsQuerySchema>;

export const apiResponseSchemas = {
  summary: apiSummarySchema,
  tasks: z.array(taskViewSchema),
  task: taskViewSchema,
  sessions: z.array(sessionSchema),
  sessionEvents: z.array(sessionEventSchema),
  chat: chatViewSchema,
};

export const streamPath = "/api/stream";
export const streamProtocol = "mastermind";
export const streamTokenProtocolPrefix = "mastermind.token.";

// Browsers can't set headers on a WebSocket, so the token travels as a second offered subprotocol.
export function streamProtocols(token: string): [string, string] {
  return [streamProtocol, `${streamTokenProtocolPrefix}${token}`];
}

export const streamMessageSchema = busEventSchema;
export type StreamMessage = z.infer<typeof streamMessageSchema>;
