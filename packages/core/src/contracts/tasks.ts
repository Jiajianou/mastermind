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

export const taskIdSchema = z
  .string()
  .max(64, "expected at most 64 characters")
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, "expected a slug such as ext2-driver");

function isRepoRelativePath(path: string): boolean {
  return !path.startsWith("/") && !path.split("/").includes("..");
}

export const touchPathSchema = z
  .string()
  .trim()
  .min(1)
  .refine(isRepoRelativePath, "expected a path inside the repo, such as src/ or package.json");

const requiredText = z.string().trim().min(1, "must not be empty");

const editableTaskFields = {
  title: requiredText,
  goal: requiredText,
  acceptance: requiredText,
  touches: z.array(touchPathSchema),
  deps: z.array(taskIdSchema),
  priority: z.int(),
};

export const newTaskSchema = z.strictObject({
  id: taskIdSchema,
  ...editableTaskFields,
  deps: editableTaskFields.deps.default([]),
  priority: editableTaskFields.priority.default(0),
});
export type NewTaskInput = z.input<typeof newTaskSchema>;

export const taskEditSchema = z.strictObject(editableTaskFields).partial();
export type TaskEdit = z.infer<typeof taskEditSchema>;
