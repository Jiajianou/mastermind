import { z } from "zod";
import { proposalStatusSchema } from "./chat.js";
import { isoTimestampSchema } from "./common.js";
import { newTaskSchema } from "./tasks.js";

export const mcpPath = "/mcp";

export const proposalRefInputSchema = z.strictObject({ proposalId: z.int().min(1) });

export const proposalOutcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json() }),
  z.object({ ok: z.literal(false), message: z.string() }),
]);
export type ProposalOutcome = z.infer<typeof proposalOutcomeSchema>;

export const proposalMetaSchema = z.object({
  proposalId: z.int(),
  status: proposalStatusSchema.optional(),
});
export type ProposalMeta = z.infer<typeof proposalMetaSchema>;

export const awaitingConfirmationSchema = z.object({
  status: z.literal("awaiting_confirmation"),
  proposalId: z.int(),
  question: z.string(),
});
export type AwaitingConfirmation = z.infer<typeof awaitingConfirmationSchema>;

export const plannedTaskSchema = newTaskSchema.extend({
  note: z.string().trim().min(1).optional(),
});

export const proposePlanInputSchema = z.strictObject({
  tasks: z.array(plannedTaskSchema).min(1),
});

export const planMetaSchema = z.object({ tasks: z.array(newTaskSchema) });
export type PlanMeta = z.infer<typeof planMetaSchema>;

export const sessionEventsInputSchema = z.strictObject({
  sessionId: z.int().min(1),
  after: z.int().min(0).optional(),
  limit: z.int().min(1).max(200).default(50),
});

export const conductorSessionSchema = z.object({
  id: z.string(),
  startedAt: isoTimestampSchema,
  endedAt: isoTimestampSchema.nullable(),
  summary: z.string().nullable(),
  tokens: z.int().nullable(),
});
export type ConductorSession = z.infer<typeof conductorSessionSchema>;
