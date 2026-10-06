import { z } from "zod";
import { isoTimestampSchema } from "./common.js";
import { taskIdSchema } from "./tasks.js";

export const checkKindSchema = z.enum([
  "setup",
  "build",
  "acceptance",
  "rebase",
  "suite",
  "reviewer",
]);
export type CheckKind = z.infer<typeof checkKindSchema>;

export const checkStatusSchema = z.enum(["running", "passed", "failed", "killed"]);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const checkSchema = z.object({
  id: z.int(),
  taskId: z.string(),
  round: z.int(),
  kind: checkKindSchema,
  status: checkStatusSchema,
  summary: z.string().nullable(),
  logPath: z.string().nullable(),
  durationMs: z.int().min(0).nullable(),
});
export type Check = z.infer<typeof checkSchema>;

export const rebaseStatusSchema = z.enum(["running", "succeeded", "failed", "killed"]);
export type RebaseStatus = z.infer<typeof rebaseStatusSchema>;

export const rebaseSchema = z.object({
  id: z.int(),
  taskId: z.string(),
  status: rebaseStatusSchema,
  logPath: z.string().nullable(),
  ts: isoTimestampSchema,
});
export type Rebase = z.infer<typeof rebaseSchema>;

export const checkLogSchema = z.object({
  check: checkSchema,
  text: z.string(),
  truncated: z.boolean(),
});
export type CheckLog = z.infer<typeof checkLogSchema>;

export const checkLogInputSchema = z.strictObject({
  taskId: taskIdSchema,
  checkId: z.int().min(1).optional(),
  lines: z.int().min(1).max(1000).default(100),
});
export type CheckLogInput = z.infer<typeof checkLogInputSchema>;
