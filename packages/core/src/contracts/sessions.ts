import { z } from "zod";
import { isoTimestampSchema } from "./common.js";

export const sessionRoleSchema = z.enum(["worker", "fixer", "reviewer", "judge", "conductor"]);
export type SessionRole = z.infer<typeof sessionRoleSchema>;

export const sessionStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "stopped",
  "killed",
  "rate_limited",
  "auth_failed",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionSchema = z.object({
  id: z.int(),
  taskId: z.string().nullable(),
  role: sessionRoleSchema,
  round: z.int().nullable(),
  attempt: z.int().nullable(),
  claudeSessionId: z.string().nullable(),
  pid: z.int().nullable(),
  pgid: z.int().nullable(),
  model: z.string().nullable(),
  status: sessionStatusSchema,
  endCommit: z.string().nullable(),
  inputTokens: z.int().nullable(),
  outputTokens: z.int().nullable(),
  startedAt: isoTimestampSchema,
  endedAt: isoTimestampSchema.nullable(),
});
export type Session = z.infer<typeof sessionSchema>;

export const eventTypeSchema = z.enum([
  "start",
  "read",
  "edit",
  "run",
  "note",
  "commit",
  "steer",
  "result",
  "error",
]);
export type EventType = z.infer<typeof eventTypeSchema>;

export const sessionEventSchema = z.object({
  id: z.int(),
  sessionId: z.int(),
  ts: isoTimestampSchema,
  type: eventTypeSchema,
  summary: z.string(),
  payload: z.string(),
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const exitOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("succeeded") }),
  z.object({ status: z.literal("failed"), reason: z.string() }),
  z.object({ status: z.literal("rate_limited"), resetAt: isoTimestampSchema.optional() }),
  z.object({ status: z.literal("auth_failed"), reason: z.string() }),
]);
export type ExitOutcome = z.infer<typeof exitOutcomeSchema>;
