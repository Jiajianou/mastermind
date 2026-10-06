import { z } from "zod";
import { isoTimestampSchema } from "./common.js";

export const runtimeFlagsSchema = z.object({
  paused: z.boolean(),
  authRequired: z.boolean(),
  backoffResumeAt: isoTimestampSchema.nullable(),
});
export type RuntimeFlags = z.infer<typeof runtimeFlagsSchema>;
