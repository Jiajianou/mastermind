import { randomBytes, randomUUID } from "node:crypto";

export interface McpServerStatus {
  name: string;
  status: "connected" | "failed";
  source: "dynamic";
}

export interface SessionContext {
  sessionId: string;
  cwd: string;
  model: string;
  permissionMode: string;
  tools: string[];
  mcpServers: McpServerStatus[];
  version: string;
  configDir: string;
}

const base62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function apiId(prefix: string): string {
  const suffix = [...randomBytes(24)].map((byte) => base62[byte % base62.length]).join("");
  return `${prefix}_011C${suffix}`;
}

export const newMessageId = (): string => apiId("msg");
export const newToolUseId = (): string => apiId("toolu");

function stamp(context: SessionContext): { session_id: string; uuid: string } {
  return { session_id: context.sessionId, uuid: randomUUID() };
}

const timestamp = (): string => new Date().toISOString();

const direct = { type: "direct" };

export function initLine(context: SessionContext): object {
  const commands = ["clear", "compact", "config", "context", "init", "model", "review", "usage"];
  return {
    type: "system",
    subtype: "init",
    cwd: context.cwd,
    session_id: context.sessionId,
    tools: context.tools,
    mcp_servers: context.mcpServers,
    model: context.model,
    permissionMode: context.permissionMode,
    slash_commands: commands,
    terminal_slash_commands: ["doctor", "color", "focus", "reload-plugins"],
    apiKeySource: "none",
    claude_code_version: context.version,
    output_style: "default",
    agents: ["claude", "Explore", "general-purpose", "Plan"],
    skills: [],
    plugins: [{ name: "agents-md", path: "builtin", source: "agents-md@builtin" }],
    capabilities: ["interrupt_receipt_v1", "interrupt_cancel_queued_v1", "msg_lifecycle_v1"],
    analytics_disabled: false,
    product_feedback_disabled: false,
    uuid: randomUUID(),
    memory_paths: {
      auto: `${context.configDir}/projects/${context.cwd.replaceAll("/", "-")}/memory/`,
    },
    messaging_socket_path: `/tmp/cc-socks/${String(process.pid)}.sock`,
    fast_mode_state: "off",
    fast_mode_disabled_reason: "sdk_opt_in_required",
    per_turn_effort_active: false,
    view_mode: "default",
  };
}

function messageUsage(): object {
  return {
    input_tokens: 10,
    cache_creation_input_tokens: 1024,
    cache_read_input_tokens: 8192,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1024 },
    output_tokens: 24,
    service_tier: "standard",
    inference_geo: "not_available",
  };
}

function apiMessage(model: string, messageId: string, content: object[]): object {
  return {
    model,
    id: messageId,
    type: "message",
    role: "assistant",
    content,
    container: null,
    stop_reason: null,
    stop_sequence: null,
    stop_details: null,
    usage: messageUsage(),
    input_transformations: [],
    diagnostics: null,
    context_management: null,
  };
}

export interface ToolUseMeta {
  displayName: string;
  serverDisplayName: string;
}

export type AssistantBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      wireInput: Record<string, unknown>;
      meta: ToolUseMeta | undefined;
    };

function toolUseExtras(
  id: string,
  wireInput: Record<string, unknown>,
  meta: ToolUseMeta | undefined,
): object {
  const metaField =
    meta === undefined
      ? {}
      : {
          tool_use_meta: [
            { id, display_name: meta.displayName, server_display_name: meta.serverDisplayName },
          ],
        };
  return { wire_tool_inputs: { [id]: wireInput }, ...metaField };
}

export function assistantLine(
  context: SessionContext,
  messageId: string,
  block: AssistantBlock,
): object {
  const content =
    block.type === "tool_use"
      ? { type: "tool_use", id: block.id, name: block.name, input: block.input, caller: direct }
      : block;
  return {
    type: "assistant",
    message: apiMessage(context.model, messageId, [content]),
    parent_tool_use_id: null,
    ...stamp(context),
    timestamp: timestamp(),
    request_id: apiId("req"),
    ...(block.type === "tool_use" ? toolUseExtras(block.id, block.wireInput, block.meta) : {}),
  };
}

export function streamEventLine(
  context: SessionContext,
  event: object,
  extra: object = {},
): object {
  return {
    type: "stream_event",
    event,
    session_id: context.sessionId,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    ...extra,
  };
}

export function partialOpeningLines(
  context: SessionContext,
  messageId: string,
  block: AssistantBlock,
): object[] {
  const started =
    block.type === "text"
      ? { type: "text", text: "" }
      : { type: "tool_use", id: block.id, name: block.name, input: {}, caller: direct };
  const deltas =
    block.type === "text"
      ? chunk(block.text).map((text) => ({ type: "text_delta", text }))
      : chunk(JSON.stringify(block.wireInput)).map((partial_json) => ({
          type: "input_json_delta",
          partial_json,
        }));
  const messageStart = { type: "message_start", message: apiMessage(context.model, messageId, []) };
  return [
    streamEventLine(context, messageStart, { ttft_ms: 420, thinking_display: "updates" }),
    streamEventLine(context, { type: "content_block_start", index: 0, content_block: started }),
    ...deltas.map((delta) =>
      streamEventLine(context, { type: "content_block_delta", index: 0, delta }),
    ),
  ];
}

export function partialClosingLines(
  context: SessionContext,
  stopReason: "end_turn" | "tool_use",
): object[] {
  const events = [
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null, stop_details: null, container: null },
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 1024,
        cache_read_input_tokens: 8192,
        output_tokens: 24,
        output_tokens_details: { thinking_tokens: 0 },
        iterations: [],
      },
      context_management: { applied_edits: [] },
    },
    { type: "message_stop" },
  ];
  return events.map((event) => streamEventLine(context, event));
}

function chunk(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [""];
}

export interface ToolResult {
  content: string | object[];
  toolUseResult: unknown;
  isError?: boolean;
}

export function toolResultLine(
  context: SessionContext,
  toolUseId: string,
  result: ToolResult,
): object {
  const errorFlag = result.isError === undefined ? {} : { is_error: result.isError };
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { tool_use_id: toolUseId, type: "tool_result", content: result.content, ...errorFlag },
      ],
    },
    parent_tool_use_id: null,
    ...stamp(context),
    timestamp: timestamp(),
    tool_use_result: result.toolUseResult,
  };
}

export function replayLine(context: SessionContext, text: string): object {
  return {
    type: "user",
    message: { role: "user", content: text },
    session_id: context.sessionId,
    parent_tool_use_id: null,
    uuid: randomUUID(),
    timestamp: timestamp(),
    isReplay: true,
  };
}

export function interruptedLine(context: SessionContext): object {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    parent_tool_use_id: null,
    ...stamp(context),
    timestamp: timestamp(),
  };
}

export function vcsStateLine(context: SessionContext, branch: string): object {
  return {
    type: "system",
    subtype: "vcs_state_changed",
    kind: "commit",
    branch,
    cwd: context.cwd,
    ...stamp(context),
  };
}

export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt: number;
  utilization: number;
}

export function rateLimitLine(context: SessionContext, info: RateLimitInfo): object {
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status: info.status,
      resetsAt: info.resetsAt,
      rateLimitType: "five_hour",
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: info.utilization, resetsAt: info.resetsAt },
        seven_day: { utilization: 0.44, resetsAt: info.resetsAt + 4 * 24 * 3600 },
      },
    },
    uuid: randomUUID(),
    session_id: context.sessionId,
  };
}

export function apiRetryLine(
  context: SessionContext,
  attempt: number,
  errorStatus: number,
  error: string,
): object {
  return {
    type: "system",
    subtype: "api_retry",
    attempt,
    max_retries: 10,
    retry_delay_ms: 500 * attempt,
    error_status: errorStatus,
    error,
    ...stamp(context),
  };
}

export function syntheticErrorLine(context: SessionContext, text: string, error: string): object {
  return {
    type: "assistant",
    message: {
      diagnostics: null,
      id: randomUUID(),
      container: null,
      model: "<synthetic>",
      role: "assistant",
      stop_details: null,
      stop_reason: "stop_sequence",
      stop_sequence: "",
      type: "message",
      usage: {
        output_tokens_details: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
        service_tier: null,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
        inference_geo: null,
        iterations: null,
        speed: null,
      },
      content: [{ type: "text", text }],
      context_management: null,
    },
    parent_tool_use_id: null,
    ...stamp(context),
    timestamp: timestamp(),
    error,
    is_api_error_message: true,
  };
}

export type ResultOutcome =
  | { kind: "success"; text: string; numTurns: number; structuredOutput?: unknown }
  | { kind: "api_error"; text: string; apiErrorStatus: number | null }
  | { kind: "interrupted"; numTurns: number };

function turnUsage(model: string, used: boolean): { usage: object; modelUsage: object } {
  const tokens = used
    ? { input: 42, output: 128, cacheRead: 16384, cacheCreation: 2048 }
    : undefined;
  return {
    usage: {
      input_tokens: tokens?.input ?? 0,
      cache_creation_input_tokens: tokens?.cacheCreation ?? 0,
      cache_read_input_tokens: tokens?.cacheRead ?? 0,
      output_tokens: tokens?.output ?? 0,
      output_tokens_details: { thinking_tokens: 0 },
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: "standard",
      cache_creation: {
        ephemeral_1h_input_tokens: tokens?.cacheCreation ?? 0,
        ephemeral_5m_input_tokens: 0,
      },
      inference_geo: used ? "not_available" : "",
      iterations: [],
      speed: "standard",
    },
    modelUsage:
      tokens === undefined
        ? {}
        : {
            [model]: {
              inputTokens: tokens.input,
              outputTokens: tokens.output,
              cacheReadInputTokens: tokens.cacheRead,
              cacheCreationInputTokens: tokens.cacheCreation,
              webSearchRequests: 0,
              costUSD: 0.01,
              contextWindow: 200000,
              maxOutputTokens: 32000,
              thinkingTokens: 0,
              canonicalModel: model.replace(/-\d{8}$/, ""),
              provider: "firstParty",
              costBasis: "list",
            },
          },
  };
}

const subagentStats = {
  spawned: 0,
  requested: { background: 0, foreground: 0, unset: 0 },
  started_in_background: 0,
  max_depth: 0,
  spawned_by_subagents: 0,
  completed: 0,
  failed: 0,
  killed: { parent: 0, user: 0, system: 0 },
  refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 },
  by_type: {},
};

export function resultLine(
  context: SessionContext,
  outcome: ResultOutcome,
  resultIndex: number,
  durationMs: number,
): object {
  const used = outcome.kind !== "api_error";
  const common = {
    duration_api_ms: used ? Math.max(durationMs - 20, 0) : 0,
    session_id: context.sessionId,
    total_cost_usd: used ? 0.01 : 0,
    ...turnUsage(context.model, used),
    permission_denials: [],
    fast_mode_state: "off",
    fast_mode_disabled_reason: "sdk_opt_in_required",
    subagent_stats: subagentStats,
    type: "result",
    duration_ms: durationMs,
    uuid: randomUUID(),
    queued_turn_count: 0,
    result_index: resultIndex,
  };
  switch (outcome.kind) {
    case "success":
      return {
        ...common,
        stop_reason: "end_turn",
        terminal_reason: "completed",
        is_error: false,
        num_turns: outcome.numTurns,
        subtype: "success",
        api_error_status: null,
        result: outcome.text,
        ...(outcome.structuredOutput === undefined
          ? {}
          : { structured_output: outcome.structuredOutput }),
      };
    case "api_error":
      return {
        ...common,
        stop_reason: "stop_sequence",
        terminal_reason: "api_error",
        is_error: true,
        num_turns: 1,
        subtype: "success",
        api_error_status: outcome.apiErrorStatus,
        result: outcome.text,
      };
    case "interrupted":
      return {
        ...common,
        stop_reason: "tool_use",
        terminal_reason: "aborted_streaming",
        is_error: true,
        num_turns: outcome.numTurns,
        subtype: "error_during_execution",
        errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use"],
      };
  }
}

export function controlResponseLine(
  requestId: string,
  outcome: { error: string } | { response: object },
): object {
  const response =
    "error" in outcome
      ? { subtype: "error", request_id: requestId, error: outcome.error }
      : { subtype: "success", request_id: requestId, response: outcome.response };
  return { type: "control_response", response };
}
