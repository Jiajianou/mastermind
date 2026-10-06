import { z } from "zod";
import { chatMessageSchema, proposalSchema } from "./chat.js";
import { checkSchema, rebaseSchema } from "./checks.js";
import { isoTimestampSchema } from "./common.js";
import { configSchema } from "./config.js";
import { sessionEventSchema, sessionSchema } from "./sessions.js";
import { taskSchema } from "./tasks.js";

export const busEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task.updated"), taskId: z.string(), task: taskSchema }),
  z.object({
    type: z.literal("session.started"),
    sessionId: z.int(),
    taskId: z.string().nullable(),
    session: sessionSchema,
  }),
  z.object({
    type: z.literal("session.event"),
    sessionId: z.int(),
    taskId: z.string().nullable(),
    event: sessionEventSchema,
    path: z.string().optional(),
  }),
  z.object({
    type: z.literal("file.changed"),
    sessionId: z.int(),
    taskId: z.string(),
    path: z.string(),
  }),
  z.object({
    type: z.literal("workspace.changed"),
    sessionId: z.int(),
    taskId: z.string(),
  }),
  z.object({
    type: z.literal("session.ended"),
    sessionId: z.int(),
    taskId: z.string().nullable(),
    session: sessionSchema,
  }),
  z.object({ type: z.literal("check.updated"), taskId: z.string(), check: checkSchema }),
  z.object({ type: z.literal("rebase.updated"), taskId: z.string(), rebase: rebaseSchema }),
  z.object({
    type: z.literal("terminal.output"),
    taskId: z.string(),
    terminalId: z.string(),
    data: z.string(),
  }),
  z.object({ type: z.literal("chat.message"), message: chatMessageSchema }),
  z.object({ type: z.literal("chat.delta"), turnId: z.string(), text: z.string() }),
  z.object({ type: z.literal("chat.turn"), turnId: z.string(), replying: z.boolean() }),
  z.object({ type: z.literal("proposal.updated"), proposal: proposalSchema }),
  z.object({ type: z.literal("auth.updated"), authRequired: z.boolean() }),
  z.object({
    type: z.literal("scheduler.updated"),
    paused: z.boolean(),
    resumeAt: isoTimestampSchema.nullable(),
  }),
  z.object({ type: z.literal("config.updated"), config: configSchema }),
  z.object({ type: z.literal("service.stopping") }),
]);
export type BusEvent = z.infer<typeof busEventSchema>;
export type BusEventType = BusEvent["type"];
type BusEventsByType = { [Event in BusEvent as Event["type"]]: Event };
export type BusEventOf<Type extends BusEventType> = BusEventsByType[Type];
