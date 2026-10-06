import { z } from "zod";
import {
  actionErrorCodeSchema,
  actionIssueSchema,
  createTasksInputSchema,
  importTasksInputSchema,
  messageSessionInputSchema,
  noInputSchema,
  sessionRefInputSchema,
  setPriorityInputSchema,
  taskRefInputSchema,
  updateTaskInputSchema,
} from "./actions.js";
import { fileContentSchema, taskChangesSchema, taskTreeSchema } from "./changes.js";
import { chatTurnSchema, chatViewSchema, proposalSchema, sendChatInputSchema } from "./chat.js";
import type { ChatTurn, Proposal } from "./chat.js";
import { isoTimestampSchema } from "./common.js";
import { proposalRefInputSchema } from "./conductor.js";
import {
  configLayerSchema,
  configSchema,
  confirmSetupInputSchema,
  subscriptionPlanSchema,
} from "./config.js";
import type { Config } from "./config.js";
import { busEventSchema } from "./events.js";
import { runtimeFlagsSchema, summarySchema } from "./runtime.js";
import type { RuntimeFlags } from "./runtime.js";
import { messageSessionResultSchema, sessionEventSchema, sessionSchema } from "./sessions.js";
import type { MessageSessionResult, Session } from "./sessions.js";
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
  messageSession: MessageSessionResult;
  pause: RuntimeFlags;
  resume: RuntimeFlags;
  setConfig: Config;
  confirmSetup: Config;
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
  messageSession: {
    method: "POST",
    path: "/api/sessions/:sessionId/message",
    intParams: ["sessionId"],
  },
  pause: { method: "POST", path: "/api/pause" },
  resume: { method: "POST", path: "/api/resume" },
  setConfig: { method: "PATCH", path: "/api/config" },
  confirmSetup: { method: "POST", path: "/api/setup/confirm" },
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

export const actionInputSchemas = {
  createTasks: createTasksInputSchema,
  importTasks: importTasksInputSchema,
  exportTasks: noInputSchema,
  updateTask: updateTaskInputSchema,
  setPriority: setPriorityInputSchema,
  moveToTop: taskRefInputSchema,
  hold: taskRefInputSchema,
  release: taskRefInputSchema,
  retry: taskRefInputSchema,
  stopSession: sessionRefInputSchema,
  messageSession: messageSessionInputSchema,
  pause: noInputSchema,
  resume: noInputSchema,
  setConfig: configLayerSchema,
  confirmSetup: confirmSetupInputSchema,
  confirmProposal: proposalRefInputSchema,
  rejectProposal: proposalRefInputSchema,
  sendChat: sendChatInputSchema,
  stopChat: noInputSchema,
} satisfies Record<ActionName, z.ZodType>;
export type ActionInputs = { [Name in ActionName]: z.input<(typeof actionInputSchemas)[Name]> };

const taskListSchema = z.array(taskSchema);

export const actionResultSchemas = {
  createTasks: taskListSchema,
  importTasks: z.object({ tasks: taskListSchema, warnings: z.array(z.string()) }),
  exportTasks: z.object({ yaml: z.string() }),
  updateTask: taskSchema,
  setPriority: taskSchema,
  moveToTop: taskSchema,
  hold: taskSchema,
  release: taskSchema,
  retry: taskSchema,
  stopSession: sessionSchema,
  messageSession: messageSessionResultSchema,
  pause: runtimeFlagsSchema,
  resume: runtimeFlagsSchema,
  setConfig: configSchema,
  confirmSetup: configSchema,
  confirmProposal: proposalSchema,
  rejectProposal: proposalSchema,
  sendChat: chatTurnSchema,
  stopChat: z.object({ stopped: z.boolean() }),
} satisfies { [Name in ActionName]: z.ZodType<ActionResults[Name]> };

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

export const instanceInfoSchema = z.object({
  project: z.string(),
  account: z.object({ email: z.string().nullable(), plan: subscriptionPlanSchema }),
});
export type InstanceInfo = z.infer<typeof instanceInfoSchema>;

export const apiResponseSchemas = {
  instance: instanceInfoSchema,
  summary: apiSummarySchema,
  tasks: z.array(taskViewSchema),
  task: taskViewSchema,
  sessions: z.array(sessionSchema),
  sessionEvents: z.array(sessionEventSchema),
  chat: chatViewSchema,
  config: configSchema,
  changes: taskChangesSchema,
  file: fileContentSchema,
  tree: taskTreeSchema,
};

export const accessTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const streamPath = "/api/stream";
export const streamProtocol = "mastermind";
export const streamTokenProtocolPrefix = "mastermind.token.";

// Browsers can't set headers on a WebSocket, so the token travels as a second offered subprotocol.
export function streamProtocols(token: string): [string, string] {
  return [streamProtocol, `${streamTokenProtocolPrefix}${token}`];
}

export const streamMessageSchema = busEventSchema;
export type StreamMessage = z.infer<typeof streamMessageSchema>;
