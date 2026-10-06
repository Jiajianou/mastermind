import { z } from "zod";
import { isoTimestampSchema } from "./common.js";
import { taskStatusSchema } from "./tasks.js";

export const runtimeFlagsSchema = z.object({
  paused: z.boolean(),
  authRequired: z.boolean(),
  backoffResumeAt: isoTimestampSchema.nullable(),
});
export type RuntimeFlags = z.infer<typeof runtimeFlagsSchema>;

export const summarySchema = z.object({
  counts: z.record(taskStatusSchema, z.int().min(0)),
  activeWorkers: z.int().min(0),
  maxWorkers: z.int().min(1),
  upNext: z.array(z.string()),
  blocked: z.array(z.string()),
  paused: z.boolean(),
  authRequired: z.boolean(),
  resumeAt: isoTimestampSchema.nullable(),
});
export type Summary = z.infer<typeof summarySchema>;
