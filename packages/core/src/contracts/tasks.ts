import { z } from "zod";
import { isoTimestampSchema } from "./common.js";

export const taskStatusSchema = z.enum([
  "pending",
  "running",
  "checking",
  "review",
  "rebasing",
  "done",
  "blocked",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  goal: z.string(),
  acceptance: z.string(),
  touches: z.array(z.string()),
  deps: z.array(z.string()),
  status: taskStatusSchema,
  priority: z.int(),
  attempts: z.int().min(0),
  round: z.int().min(1),
  held: z.boolean(),
  resumeSession: z.string().nullable(),
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  baseCommit: z.string().nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});
export type Task = z.infer<typeof taskSchema>;
