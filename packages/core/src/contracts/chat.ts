import { z } from "zod";
import { isoTimestampSchema, jsonValueSchema } from "./common.js";
import { eventLineKindSchema, modelSchema } from "./config.js";

export const chatMessageKindSchema = z.enum([
  "user",
  "conductor",
  "action",
  "proposal",
  "plan",
  "system",
  "step",
  "question",
]);
export type ChatMessageKind = z.infer<typeof chatMessageKindSchema>;

export const conversationSchema = z.object({
  id: z.int(),
  title: z.string().nullable(),
  startedAt: isoTimestampSchema,
  lastActivityAt: isoTimestampSchema,
});
export type Conversation = z.infer<typeof conversationSchema>;

export const chatMessageSchema = z.object({
  id: z.int(),
  conversationId: z.int(),
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

export const chatViewSchema = chatStatusSchema.extend({
  conversationId: z.int(),
  conversations: z.array(conversationSchema),
  messages: z.array(chatMessageSchema),
});
export type ChatView = z.infer<typeof chatViewSchema>;

export const chatQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).optional(),
});

export const questionAnswerSchema = z.object({
  questionId: z.int().min(1),
  answer: z.string().trim().min(1),
});
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

export const answersMetaSchema = z.object({ answers: z.array(questionAnswerSchema).min(1) });
export type AnswersMeta = z.infer<typeof answersMetaSchema>;

export const conversationRefInputSchema = z.strictObject({ conversationId: z.int().min(1) });

export const sendChatInputSchema = z.strictObject({
  text: z.string().trim().min(1),
  model: modelSchema.optional(),
  answers: z.array(questionAnswerSchema).min(1).optional(),
});

export const chatTurnSchema = z.object({ turnId: z.string(), message: chatMessageSchema });
export type ChatTurn = z.infer<typeof chatTurnSchema>;

export const eventLineMetaSchema = z.discriminatedUnion("event", [
  z.object({
    event: eventLineKindSchema.extract(["review", "blocked", "rebased", "stuck"]),
    taskId: z.string(),
  }),
  z.object({ event: z.literal("sign_in") }),
  z.object({ event: z.literal("owner_on_main"), branch: z.string() }),
  z.object({
    event: eventLineKindSchema.extract(["branch_rebased", "branch_failed"]),
    branch: z.string(),
  }),
  z.object({ event: z.literal("usage_limit"), resumeAt: isoTimestampSchema }),
]);
export type EventLineMeta = z.infer<typeof eventLineMetaSchema>;

export const stepStatusSchema = z.enum(["running", "done", "failed"]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const stepMetaSchema = z.object({
  step: z.enum(["thinking", "tool"]),
  status: stepStatusSchema,
  detail: z.string().nullable(),
});
export type StepMeta = z.infer<typeof stepMetaSchema>;

export const questionOptionSchema = z.object({
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().max(240).optional(),
});
export type QuestionOption = z.infer<typeof questionOptionSchema>;

export const questionMetaSchema = z.object({
  header: z.string().nullable(),
  options: z.array(questionOptionSchema).min(2),
  multiSelect: z.boolean(),
});
export type QuestionMeta = z.infer<typeof questionMetaSchema>;

export const setupMetaSchema = z.object({ setup: z.literal("confirmed") });
export type SetupMeta = z.infer<typeof setupMetaSchema>;
