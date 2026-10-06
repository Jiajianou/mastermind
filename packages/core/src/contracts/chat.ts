import { z } from "zod";
import { isoTimestampSchema, jsonValueSchema } from "./common.js";

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
