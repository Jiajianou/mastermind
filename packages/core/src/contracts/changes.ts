import { z } from "zod";
import { taskIdSchema } from "./tasks.js";

export const changesSinceSchema = z
  .string()
  .regex(/^(?:base|round:[1-9]\d{0,5})$/, "expected base or round:N");

export type ChangesSince = { kind: "base" } | { kind: "round"; round: number };

export function parseChangesSince(since: string): ChangesSince {
  return since.startsWith("round:")
    ? { kind: "round", round: Number(since.slice("round:".length)) }
    : { kind: "base" };
}

export const changeStatusSchema = z.enum(["added", "modified", "deleted", "renamed"]);
export type ChangeStatus = z.infer<typeof changeStatusSchema>;

export const fileChangeSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: changeStatusSchema,
  additions: z.int().nullable(),
  deletions: z.int().nullable(),
  binary: z.boolean(),
  uncommitted: z.boolean(),
});
export type FileChange = z.infer<typeof fileChangeSchema>;

export const taskChangesSchema = z.object({
  taskId: z.string(),
  since: changesSinceSchema,
  fromCommit: z.string(),
  files: z.array(fileChangeSchema),
});
export type TaskChanges = z.infer<typeof taskChangesSchema>;

export const changesQuerySchema = z.strictObject({
  since: changesSinceSchema.default("base"),
});

export const changesInputSchema = changesQuerySchema.extend({ taskId: taskIdSchema });
export type ChangesInput = z.infer<typeof changesInputSchema>;

export const fileSideSchema = z.enum(["base", "current"]);
export type FileSide = z.infer<typeof fileSideSchema>;

export const fileQuerySchema = z.strictObject({
  path: z.string().min(1),
  side: fileSideSchema.default("current"),
  since: changesSinceSchema.default("base"),
});
export type FileQuery = z.infer<typeof fileQuerySchema>;

const fileHead = { path: z.string(), side: fileSideSchema };

export const fileContentSchema = z.discriminatedUnion("kind", [
  z.object({ ...fileHead, kind: z.literal("text"), size: z.int(), content: z.string() }),
  z.object({ ...fileHead, kind: z.literal("binary"), size: z.int() }),
  z.object({ ...fileHead, kind: z.literal("too_large"), size: z.int() }),
  z.object({ ...fileHead, kind: z.literal("missing") }),
]);
export type FileContent = z.infer<typeof fileContentSchema>;

export const maxFileBytes = 1024 * 1024;

export const taskTreeSchema = z.object({
  taskId: z.string(),
  files: z.array(z.string()),
});
export type TaskTree = z.infer<typeof taskTreeSchema>;
