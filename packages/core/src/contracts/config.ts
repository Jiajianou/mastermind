import { z } from "zod";

const durationUnitsMs = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const durationPattern = /^(?:\d+(?:ms|s|m|h|d))+$/;
const durationPartPattern = /(\d+)(ms|s|m|h|d)/g;

function isDurationUnit(unit: string): unit is keyof typeof durationUnitsMs {
  return Object.hasOwn(durationUnitsMs, unit);
}

export function parseDuration(text: string): number | null {
  if (!durationPattern.test(text)) return null;
  let total = 0;
  for (const [, amount, unit] of text.matchAll(durationPartPattern)) {
    if (amount === undefined || unit === undefined || !isDurationUnit(unit)) return null;
    total += Number(amount) * durationUnitsMs[unit];
  }
  return total > 0 ? total : null;
}

export const durationSchema = z
  .string()
  .refine((text) => parseDuration(text) !== null, "expected a duration such as 60m, 90s or 1h30m");

export const subscriptionPlanSchema = z.enum(["pro", "max"]);
export type SubscriptionPlan = z.infer<typeof subscriptionPlanSchema>;

const planNames: Record<SubscriptionPlan, string> = { pro: "Pro", max: "Max" };

export const planLabel = (plan: SubscriptionPlan): string => planNames[plan];

export const maxWorkersSchema = z.union([z.literal("auto"), z.int().min(1)], {
  error: 'expected "auto" or a whole number of at least 1',
});
export type MaxWorkers = z.infer<typeof maxWorkersSchema>;

export function resolveMaxWorkers(maxWorkers: MaxWorkers, plan: SubscriptionPlan): number {
  if (maxWorkers !== "auto") return maxWorkers;
  return plan === "max" ? 2 : 1;
}

export const workerPermissionsSchema = z.enum(["bypass", "auto", "allowlist"]);
export type WorkerPermissions = z.infer<typeof workerPermissionsSchema>;

// The pattern reaches the Claude API in set_config's JSON schema, whose validator reads a `[` inside a character
// class as a nested class and then rejects the Conductor's whole tool list, so `[` stays outside the class.
export const modelSchema = z
  .string()
  .regex(/^(?:[\w.\]-]|\[)+$/, "expected a model name such as opus, sonnet or haiku");

const nonEmptyString = z.string().trim().min(1);

const modelsSchema = z.strictObject({
  worker: modelSchema,
  fixer: modelSchema,
  reviewer: modelSchema,
  judge: modelSchema,
  conductor: modelSchema,
});

export const commandKindSchema = z.enum(["setup", "build", "test"]);
export type CommandKind = z.infer<typeof commandKindSchema>;

const commandsSchema = z.strictObject({ setup: z.string(), build: z.string(), test: z.string() });
const reviewerSchema = z.strictObject({ enabled: z.boolean() });
const notificationsSchema = z.strictObject({ desktop: z.boolean() });
const stuckCheckSchema = z.strictObject({ after: durationSchema, every: durationSchema });
const sandboxSchema = z.strictObject({
  enabled: z.boolean(),
  allowedDomains: z.array(nonEmptyString),
  allowWrite: z.array(nonEmptyString),
});
const conductorSchema = z.strictObject({
  confirm: z.array(nonEmptyString),
  wakeOnEvents: z.array(nonEmptyString),
});

export const configSchema = z.strictObject({
  mainBranch: nonEmptyString,
  worktreeDir: nonEmptyString,
  maxWorkers: maxWorkersSchema,
  maxAttempts: z.int().min(1),
  models: modelsSchema,
  commands: commandsSchema,
  autoRebase: z.boolean(),
  requireReviewFor: z.array(nonEmptyString),
  workerPermissions: workerPermissionsSchema,
  workerAllowedTools: z.array(nonEmptyString),
  reviewer: reviewerSchema,
  notifications: notificationsSchema,
  stuckCheck: stuckCheckSchema,
  sandbox: sandboxSchema,
  conductor: conductorSchema,
  port: z.int().min(1).max(65_535),
});
export type Config = z.infer<typeof configSchema>;

export const configLayerSchema = configSchema.partial().extend({
  models: modelsSchema.partial().optional(),
  commands: commandsSchema.partial().optional(),
  reviewer: reviewerSchema.partial().optional(),
  notifications: notificationsSchema.partial().optional(),
  stuckCheck: stuckCheckSchema.partial().optional(),
  sandbox: sandboxSchema.partial().optional(),
  conductor: conductorSchema.partial().optional(),
});
export type ConfigLayer = z.infer<typeof configLayerSchema>;

export const toolchainSchema = z.enum([
  "npm",
  "pnpm",
  "yarn",
  "cargo",
  "go",
  "pip",
  "uv",
  "poetry",
]);
export type Toolchain = z.infer<typeof toolchainSchema>;

export const detectedCommandSchema = z.object({ command: z.string(), source: z.string() });
export type DetectedCommand = z.infer<typeof detectedCommandSchema>;

export const projectDetectionSchema = z.object({
  commands: z.object({
    setup: detectedCommandSchema.nullable(),
    build: detectedCommandSchema.nullable(),
    test: detectedCommandSchema.nullable(),
  }),
  toolchains: z.array(toolchainSchema),
  warnings: z.array(z.string()),
});
export type ProjectDetection = z.infer<typeof projectDetectionSchema>;
