import { z } from "zod";

export const findingSeveritySchema = z.enum(["minor", "serious"]);
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;

export const findingSchema = z.object({
  id: z.int(),
  taskId: z.string(),
  round: z.int(),
  file: z.string(),
  line: z.int().nullable(),
  text: z.string(),
  severity: findingSeveritySchema,
  dismissed: z.boolean(),
});
export type Finding = z.infer<typeof findingSchema>;

export const commentSchema = z.object({
  id: z.int(),
  taskId: z.string(),
  round: z.int(),
  file: z.string(),
  lineStart: z.int(),
  lineEnd: z.int(),
  excerpt: z.string(),
  text: z.string(),
});
export type Comment = z.infer<typeof commentSchema>;
