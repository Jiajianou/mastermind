import { z } from "zod";

const sessionIdField = z.string().nullish();

export const streamUsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
});
export type StreamUsage = z.infer<typeof streamUsageSchema>;

const knownContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("thinking") }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]).nullish(),
    is_error: z.boolean().nullish(),
  }),
]);

export const streamContentBlockSchema = z.union([
  knownContentBlockSchema,
  z.object({ type: z.string() }).transform(() => ({ type: "other" as const })),
]);
export type StreamContentBlock = z.infer<typeof streamContentBlockSchema>;

const systemInitLineSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("init"),
  session_id: sessionIdField,
  cwd: z.string(),
  model: z.string(),
  permissionMode: z.string(),
  tools: z.array(z.string()),
  mcp_servers: z.array(z.object({ name: z.string(), status: z.string() })),
});

const apiRetryLineSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("api_retry"),
  session_id: sessionIdField,
  attempt: z.number(),
  max_retries: z.number(),
  error_status: z.number().nullish(),
  error: z.string().nullish(),
});

const vcsStateChangedLineSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("vcs_state_changed"),
  session_id: sessionIdField,
  kind: z.string(),
  branch: z.string().nullish(),
});

const permissionDeniedLineSchema = z.object({
  type: z.literal("system"),
  subtype: z.literal("permission_denied"),
  session_id: sessionIdField,
  tool_name: z.string(),
  tool_use_id: z.string().nullish(),
  message: z.string(),
});

const assistantLineSchema = z.object({
  type: z.literal("assistant"),
  session_id: sessionIdField,
  message: z.object({
    content: z.array(streamContentBlockSchema),
    usage: streamUsageSchema.nullish(),
  }),
  error: z.string().nullish(),
});

const userLineSchema = z.object({
  type: z.literal("user"),
  session_id: sessionIdField,
  message: z.object({ content: z.union([z.string(), z.array(streamContentBlockSchema)]) }),
  isReplay: z.boolean().nullish(),
  tool_use_result: z.unknown().optional(),
});

function lenient<Schema extends z.ZodType>(schema: Schema) {
  return schema.nullish().catch(null);
}

// Every field is lenient: a result line must always be recognised, because it is what ends a turn.
const resultLineSchema = z.object({
  type: z.literal("result"),
  subtype: lenient(z.string()),
  session_id: lenient(z.string()),
  is_error: lenient(z.boolean()),
  result: lenient(z.string()),
  num_turns: lenient(z.number()),
  usage: lenient(streamUsageSchema),
  api_error_status: lenient(z.number()),
  terminal_reason: lenient(z.string()),
  structured_output: z.unknown().optional(),
});

export const rateLimitStatusSchema = z.enum(["allowed", "allowed_warning", "rejected"]);
export type RateLimitStatus = z.infer<typeof rateLimitStatusSchema>;

const rateLimitLineSchema = z.object({
  type: z.literal("rate_limit_event"),
  session_id: sessionIdField,
  rate_limit_info: z.object({
    status: rateLimitStatusSchema,
    resetsAt: z.number().nullish(),
    rateLimitType: z.string().nullish(),
  }),
});

const streamEventLineSchema = z.object({
  type: z.literal("stream_event"),
  session_id: sessionIdField,
  event: z.object({
    type: z.string(),
    delta: z.object({ type: z.string().optional(), text: z.string().optional() }).optional(),
  }),
});

export const streamLineSchema = z.discriminatedUnion("type", [
  z.discriminatedUnion("subtype", [
    systemInitLineSchema,
    apiRetryLineSchema,
    vcsStateChangedLineSchema,
    permissionDeniedLineSchema,
  ]),
  assistantLineSchema,
  userLineSchema,
  resultLineSchema,
  rateLimitLineSchema,
  streamEventLineSchema,
]);
export type StreamLine = z.infer<typeof streamLineSchema>;

export const streamLineEnvelopeSchema = z.object({
  type: z.string(),
  subtype: z.string().optional(),
});

export const bashToolResultSchema = z.object({
  stdout: z.string().optional(),
  gitOperation: z
    .object({ commit: z.object({ sha: z.string(), branch: z.string().nullish() }).optional() })
    .optional(),
});
