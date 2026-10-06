import { z } from "zod";

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
