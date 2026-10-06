import { z } from "zod";
import { isoTimestampSchema, jsonValueSchema } from "./common.js";
import { modelSchema } from "./config.js";

export const chatMessageKindSchema = z.enum([
  "user",
  "conductor",
  "action",
  "proposal",
  "plan",
  "system",
]);
export type ChatMessageKind = z.infer<typeof chatMessageKindSchema>;

export const chatMessageSchema = z.object({
  id: z.int(),
  ts: isoTimestampSchema,
  kind: chatMessageKindSchema,
  content: z.string(),
  meta: jsonValueSchema,
  conductorSession: z.string().nullable(),
  turnId: z.string().nullable(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const proposalStatusSchema = z.enum(["pending", "confirmed", "rejected", "expired"]);
export type ProposalStatus = z.infer<typeof proposalStatusSchema>;

export const proposalSchema = z.object({
  id: z.int(),
  ts: isoTimestampSchema,
  action: z.string(),
  args: jsonValueSchema,
  status: proposalStatusSchema,
  decidedAt: isoTimestampSchema.nullable(),
  result: jsonValueSchema,
});
export type Proposal = z.infer<typeof proposalSchema>;

export const chatTurnRefSchema = z.object({
  turnId: z.string(),
  conductorSession: z.string().nullable(),
});
export type ChatTurnRef = z.infer<typeof chatTurnRefSchema>;

export const chatStatusSchema = z.object({ model: modelSchema, replying: z.boolean() });
export type ChatStatus = z.infer<typeof chatStatusSchema>;

export const chatViewSchema = chatStatusSchema.extend({ messages: z.array(chatMessageSchema) });
export type ChatView = z.infer<typeof chatViewSchema>;

export const chatQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).optional(),
});

export const sendChatInputSchema = z.strictObject({
  text: z.string().trim().min(1),
  model: modelSchema.optional(),
});

export const chatTurnSchema = z.object({ turnId: z.string(), message: chatMessageSchema });
export type ChatTurn = z.infer<typeof chatTurnSchema>;

export const eventLineKindSchema = z.enum([
  "review",
  "blocked",
  "rebased",
  "sign_in",
  "usage_limit",
]);
export type EventLineKind = z.infer<typeof eventLineKindSchema>;

export const eventLineMetaSchema = z.discriminatedUnion("event", [
  z.object({ event: z.enum(["review", "blocked", "rebased"]), taskId: z.string() }),
  z.object({ event: z.literal("sign_in") }),
  z.object({ event: z.literal("usage_limit"), resumeAt: isoTimestampSchema }),
]);
export type EventLineMeta = z.infer<typeof eventLineMetaSchema>;
