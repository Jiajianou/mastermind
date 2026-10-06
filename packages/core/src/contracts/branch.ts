import { z } from "zod";
import { isoTimestampSchema } from "./common.js";

export const branchRebaseStatusSchema = z.enum(["running", "succeeded", "failed"]);
export type BranchRebaseStatus = z.infer<typeof branchRebaseStatusSchema>;

export const branchRebaseSchema = z.object({
  branch: z.string(),
  status: branchRebaseStatusSchema,
  startedAt: isoTimestampSchema,
  endedAt: isoTimestampSchema.nullable(),
  outcome: z.string().nullable(),
  logPath: z.string(),
});
export type BranchRebase = z.infer<typeof branchRebaseSchema>;

export const mainUpstreamSchema = z.object({ name: z.string(), ahead: z.int().min(0) });
export type MainUpstream = z.infer<typeof mainUpstreamSchema>;

export const ownerBranchSchema = z.object({
  branch: z.string().nullable(),
  mainBranch: z.string(),
  onMain: z.boolean(),
  ahead: z.int().min(0),
  behind: z.int().min(0),
  upstream: mainUpstreamSchema.nullable(),
  rebase: branchRebaseSchema.nullable(),
});
export type OwnerBranch = z.infer<typeof ownerBranchSchema>;

export const rebaseOwnerBranchInputSchema = z.strictObject({
  branch: z.string().trim().min(1).optional(),
});
