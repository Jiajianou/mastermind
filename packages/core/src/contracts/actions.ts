import { z } from "zod";
import { newTaskSchema, taskEditSchema, taskIdSchema } from "./tasks.js";

export const actionErrorCodeSchema = z.enum(["invalid_input", "not_found", "conflict"]);
export type ActionErrorCode = z.infer<typeof actionErrorCodeSchema>;

export const actionIssueSchema = z.object({ path: z.string().nullable(), message: z.string() });
export type ActionIssue = z.infer<typeof actionIssueSchema>;

export const actionErrorSchema = z.object({
  code: actionErrorCodeSchema,
  message: z.string(),
  issues: z.array(actionIssueSchema),
});
export type ActionErrorBody = z.infer<typeof actionErrorSchema>;

export const noInputSchema = z.strictObject({}).default({});

export const taskRefInputSchema = z.strictObject({ taskId: taskIdSchema });

export const createTasksInputSchema = z.strictObject({ tasks: z.array(newTaskSchema).min(1) });

function hasChanges(input: Record<string, unknown>): boolean {
  return Object.entries(input).some(([key, value]) => key !== "taskId" && value !== undefined);
}

export const updateTaskInputSchema = taskEditSchema
  .extend({ taskId: taskIdSchema })
  .refine(hasChanges, { error: "expected at least one field to change" });

export const setPriorityInputSchema = z.strictObject({ taskId: taskIdSchema, priority: z.int() });

export const importTasksInputSchema = z.strictObject({ yaml: z.string() });

export const sessionRefInputSchema = z.strictObject({ sessionId: z.int().min(1) });

export const steeringMessageMaxLength = 20_000;

export const messageSessionInputSchema = z.strictObject({
  sessionId: z.int().min(1),
  text: z.string().trim().min(1).max(steeringMessageMaxLength),
});
