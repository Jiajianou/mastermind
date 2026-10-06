import { z } from "zod";
import { isoTimestampSchema } from "./common.js";

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
