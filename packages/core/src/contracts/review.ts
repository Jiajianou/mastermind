import { z } from "zod";
import { isoTimestampSchema } from "./common.js";
import { sessionSchema } from "./sessions.js";
import { isRepoRelativePath, taskIdSchema, taskSchema } from "./tasks.js";

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

export const roundModeSchema = z.enum(["resume", "fresh"]);
export type RoundMode = z.infer<typeof roundModeSchema>;

export const roundSchema = z.object({
  id: z.int(),
  taskId: z.string(),
  round: z.int().min(2),
  mode: roundModeSchema,
  instruction: z.string(),
  message: z.string(),
  commentIds: z.array(z.int()),
  findingIds: z.array(z.int()),
  failingCheckId: z.int().nullable(),
  startCommit: z.string().nullable(),
  sessionId: z.int().nullable(),
  createdAt: isoTimestampSchema,
});
export type Round = z.infer<typeof roundSchema>;

export const reviewNotesSchema = z.object({
  taskId: z.string(),
  round: z.int(),
  comments: z.array(commentSchema),
  findings: z.array(findingSchema),
  rounds: z.array(roundSchema),
});
export type ReviewNotes = z.infer<typeof reviewNotesSchema>;

export const reviewTextMaxLength = 20_000;

const reviewText = z.string().trim().min(1, "must not be empty").max(reviewTextMaxLength);

const commentFileSchema = z
  .string()
  .min(1)
  .refine(isRepoRelativePath, "expected a file path inside the repo");

export const addCommentInputSchema = z
  .strictObject({
    taskId: taskIdSchema,
    file: commentFileSchema,
    lineStart: z.int().min(1),
    lineEnd: z.int().min(1),
    excerpt: z.string().max(reviewTextMaxLength).default(""),
    text: reviewText,
  })
  .refine(({ lineStart, lineEnd }) => lineEnd >= lineStart, {
    error: "lineEnd must not be before lineStart",
    path: ["lineEnd"],
  });

export const commentRefInputSchema = z.strictObject({
  taskId: taskIdSchema,
  commentId: z.int().min(1),
});

export const updateCommentInputSchema = commentRefInputSchema.extend({ text: reviewText });

export const findingRefInputSchema = z.strictObject({ findingId: z.int().min(1) });

const ids = z.array(z.int().min(1)).default([]);

export const requestChangesInputSchema = z
  .strictObject({
    taskId: taskIdSchema,
    instruction: z.string().trim().max(reviewTextMaxLength).default(""),
    commentIds: ids,
    findingIds: ids,
    includeFailingTest: z.boolean().default(false),
    mode: roundModeSchema.default("resume"),
  })
  .refine(
    (input) =>
      input.instruction !== "" ||
      input.commentIds.length > 0 ||
      input.findingIds.length > 0 ||
      input.includeFailingTest,
    { error: "expected an instruction, a comment, a finding or the failing test to send" },
  );
export type RequestChangesInput = z.infer<typeof requestChangesInputSchema>;

export const requestChangesResultSchema = z.object({
  task: taskSchema,
  session: sessionSchema,
  round: roundSchema,
});
export type RequestChangesResult = z.infer<typeof requestChangesResultSchema>;
