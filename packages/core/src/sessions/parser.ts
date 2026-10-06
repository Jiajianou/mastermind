import { streamLineEnvelopeSchema, streamLineSchema } from "../contracts/index.js";
import type {
  EventType,
  RateLimitStatus,
  StreamContentBlock,
  StreamLine,
  StreamUsage,
} from "../contracts/index.js";
import { commitSummary, detectCommit } from "./commits.js";
import type { CommitInfo, VcsCommit } from "./commits.js";
import { failureText, firstLine, oneLine } from "./summary.js";
import { describeToolUse } from "./tools.js";
import type { ToolCall } from "./tools.js";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface RateLimit {
  status: RateLimitStatus;
  resetsAt: string | null;
  window: string | null;
}

export type EventDetails =
  | {
      line: "init";
      sessionId: string | null;
      cwd: string;
      model: string;
      permissionMode: string;
      tools: string[];
      mcpServers: { name: string; status: string }[];
    }
  | {
      line: "tool_use";
      sessionId: string | null;
      toolUseId: string;
      toolName: string;
      filePath: string | null;
      command: string | null;
      usage: TokenUsage | null;
    }
  | { line: "assistant"; sessionId: string | null; text: string | null; usage: TokenUsage | null }
  | { line: "api_error"; sessionId: string | null; error: string; text: string }
  | {
      line: "tool_result";
      sessionId: string | null;
      toolUseId: string;
      toolName: string | null;
      filePath: string | null;
      command: string | null;
      isError: boolean;
      output: string;
      commit: CommitInfo | null;
    }
  | { line: "user"; sessionId: string | null; text: string; isReplay: boolean }
  | {
      line: "result";
      sessionId: string | null;
      isError: boolean;
      resultText: string | null;
      usage: TokenUsage | null;
      numTurns: number | null;
      apiErrorStatus: number | null;
      terminalReason: string | null;
      structuredOutput: unknown;
    }
  | { line: "rate_limit"; sessionId: string | null; rateLimit: RateLimit }
  | { line: "partial"; sessionId: string | null; textDelta: string | null }
  | {
      line: "permission_denied";
      sessionId: string | null;
      toolName: string;
      toolUseId: string | null;
      message: string;
    }
  | {
      line: "api_retry";
      sessionId: string | null;
      attempt: number;
      maxRetries: number;
      error: string | null;
      errorStatus: number | null;
    }
  | { line: "vcs"; sessionId: string | null; kind: string; branch: string | null }
  | { line: "other"; lineType: string | null };

export interface ParsedEvent {
  type: EventType;
  summary: string;
  payload: string;
  stored: boolean;
  details: EventDetails;
}

export interface StreamParser {
  parseLine(line: string): ParsedEvent;
}

type DerivedEvent = Omit<ParsedEvent, "payload">;
type SystemLine = Extract<StreamLine, { type: "system" }>;
type UserLine = Extract<StreamLine, { type: "user" }>;
type ResultLine = Extract<StreamLine, { type: "result" }>;
type AssistantLine = Extract<StreamLine, { type: "assistant" }>;
type ToolResultBlock = Extract<StreamContentBlock, { type: "tool_result" }>;

function tokenUsage(usage: StreamUsage | null | undefined): TokenUsage | null {
  if (usage === null || usage === undefined) return null;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
  };
}

function blockText(blocks: readonly unknown[]): string {
  return blocks
    .flatMap((block) =>
      typeof block === "object" &&
      block !== null &&
      "text" in block &&
      typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
}

function contentText(content: string | readonly unknown[] | null | undefined): string {
  if (content === null || content === undefined) return "";
  return typeof content === "string" ? content : blockText(content);
}

function unixSecondsToIso(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function event(
  type: EventType,
  summary: string,
  details: EventDetails,
  stored = true,
): DerivedEvent {
  return { type, summary: oneLine(summary), stored, details };
}

function otherLine(lineType: string | null, summary: string): DerivedEvent {
  return event("note", summary, { line: "other", lineType }, false);
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? "" : "s"}`;
}

export function createStreamParser(): StreamParser {
  let cwd: string | null = null;
  let initSeen = false;
  let turnPromptSeen = false;
  let vcsCommit: VcsCommit | null = null;
  const toolCalls = new Map<string, ToolCall>();
  const deniedToolUses = new Set<string>();

  function assistantEvent(line: AssistantLine): DerivedEvent {
    const sessionId = line.session_id ?? null;
    const blocks = line.message.content;
    const text = blockText(blocks);
    if (line.error !== null && line.error !== undefined) {
      return event("error", `${firstLine(text)} (${line.error})`, {
        line: "api_error",
        sessionId,
        error: line.error,
        text,
      });
    }

    const usage = tokenUsage(line.message.usage);
    const toolUse = blocks.find((block) => block.type === "tool_use");
    if (toolUse !== undefined) {
      const call = describeToolUse(toolUse.name, toolUse.input, cwd);
      toolCalls.set(toolUse.id, call);
      return event(call.type, call.summary, {
        line: "tool_use",
        sessionId,
        toolUseId: toolUse.id,
        toolName: call.name,
        filePath: call.filePath,
        command: call.command,
        usage,
      });
    }

    const hasText = blocks.some((block) => block.type === "text");
    return hasText
      ? event("note", firstLine(text), { line: "assistant", sessionId, text, usage })
      : event("note", "Thinking", { line: "assistant", sessionId, text: null, usage }, false);
  }

  function toolResultEvent(line: UserLine, block: ToolResultBlock): DerivedEvent {
    const call = toolCalls.get(block.tool_use_id) ?? null;
    const output = contentText(block.content);
    const isError = block.is_error === true;
    const reportedCommit = vcsCommit;
    vcsCommit = null;
    const commit = isError
      ? null
      : detectCommit(call?.command ?? null, output, line.tool_use_result, reportedCommit);
    const details: EventDetails = {
      line: "tool_result",
      sessionId: line.session_id ?? null,
      toolUseId: block.tool_use_id,
      toolName: call?.name ?? null,
      filePath: call?.filePath ?? null,
      command: call?.command ?? null,
      isError,
      output,
      commit,
    };
    if (commit !== null) return event("commit", commitSummary(commit), details);
    if (isError) {
      const failed = `${call?.name ?? "Tool"} failed: ${failureText(output)}`;
      return event("error", failed, details, !deniedToolUses.has(block.tool_use_id));
    }
    return event("note", firstLine(output), details, false);
  }

  function userEvent(line: UserLine): DerivedEvent {
    const content = line.message.content;
    const toolResult =
      typeof content === "string"
        ? undefined
        : content.find((block) => block.type === "tool_result");
    if (toolResult !== undefined) return toolResultEvent(line, toolResult);

    const text = contentText(content);
    const isReplay = line.isReplay === true;
    const details: EventDetails = {
      line: "user",
      sessionId: line.session_id ?? null,
      text,
      isReplay,
    };
    if (!isReplay) return event("note", firstLine(text), details);
    if (turnPromptSeen) return event("steer", text, details);
    turnPromptSeen = true;
    return event("note", firstLine(text), details, false);
  }

  function systemEvent(line: SystemLine): DerivedEvent {
    const sessionId = line.session_id ?? null;
    switch (line.subtype) {
      case "init": {
        const first = !initSeen;
        initSeen = true;
        cwd = line.cwd;
        const summary = `${line.model} · ${line.permissionMode} · ${plural(line.tools.length, "tool")}`;
        const details: EventDetails = {
          line: "init",
          sessionId,
          cwd: line.cwd,
          model: line.model,
          permissionMode: line.permissionMode,
          tools: line.tools,
          mcpServers: line.mcp_servers.map(({ name, status }) => ({ name, status })),
        };
        return event("start", summary, details, first);
      }
      case "api_retry": {
        const reason = line.error ?? line.error_status?.toString() ?? "unknown error";
        return event(
          "note",
          `API retry ${String(line.attempt)}/${String(line.max_retries)} (${reason})`,
          {
            line: "api_retry",
            sessionId,
            attempt: line.attempt,
            maxRetries: line.max_retries,
            error: line.error ?? null,
            errorStatus: line.error_status ?? null,
          },
        );
      }
      case "vcs_state_changed": {
        const branch = line.branch ?? null;
        const details: EventDetails = { line: "vcs", sessionId, kind: line.kind, branch };
        const where = branch === null ? "" : ` on ${branch}`;
        if (line.kind !== "commit") return event("note", `git ${line.kind}${where}`, details);
        // The Bash tool_result that follows carries the sha and subject and becomes the stored commit event.
        vcsCommit = { branch };
        return event("commit", `Committed${where}`, details, false);
      }
      case "permission_denied": {
        const toolUseId = line.tool_use_id ?? null;
        if (toolUseId !== null) deniedToolUses.add(toolUseId);
        return event("error", `Denied ${line.tool_name}: ${firstLine(line.message)}`, {
          line: "permission_denied",
          sessionId,
          toolName: line.tool_name,
          toolUseId,
          message: line.message,
        });
      }
    }
  }

  function resultEvent(line: ResultLine): DerivedEvent {
    turnPromptSeen = false;
    const isError = line.is_error ?? line.subtype !== "success";
    const resultText = line.result ?? null;
    const details: EventDetails = {
      line: "result",
      sessionId: line.session_id ?? null,
      isError,
      resultText,
      usage: tokenUsage(line.usage),
      numTurns: line.num_turns ?? null,
      apiErrorStatus: line.api_error_status ?? null,
      terminalReason: line.terminal_reason ?? null,
      structuredOutput: line.structured_output,
    };
    if (!isError) return event("result", `Done in ${plural(line.num_turns ?? 0, "turn")}`, details);
    const reason = line.terminal_reason ?? line.subtype ?? "error";
    return event(
      "error",
      resultText === null ? `Ended: ${reason}` : firstLine(resultText),
      details,
    );
  }

  function derive(line: StreamLine): DerivedEvent {
    const sessionId = line.session_id ?? null;
    switch (line.type) {
      case "system":
        return systemEvent(line);
      case "assistant":
        return assistantEvent(line);
      case "user":
        return userEvent(line);
      case "result":
        return resultEvent(line);
      case "rate_limit_event": {
        const info = line.rate_limit_info;
        const rateLimit: RateLimit = {
          status: info.status,
          resetsAt: unixSecondsToIso(info.resetsAt),
          window: info.rateLimitType ?? null,
        };
        const resets = rateLimit.resetsAt === null ? "" : `, resets ${rateLimit.resetsAt}`;
        const summary = `Usage ${info.status} (${rateLimit.window ?? "unknown window"}${resets})`;
        return event("note", summary, { line: "rate_limit", sessionId, rateLimit }, false);
      }
      case "stream_event": {
        const delta = line.event.delta;
        const textDelta = delta?.type === "text_delta" ? (delta.text ?? null) : null;
        const summary = [line.event.type, delta?.type]
          .filter((part) => part !== undefined)
          .join(" ");
        return event("note", summary, { line: "partial", sessionId, textDelta }, false);
      }
    }
  }

  function parse(raw: string): DerivedEvent {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return otherLine(null, `Unreadable output: ${raw}`);
    }
    const line = streamLineSchema.safeParse(json);
    if (line.success) return derive(line.data);
    const envelope = streamLineEnvelopeSchema.safeParse(json);
    if (!envelope.success) return otherLine(null, `Unrecognised output: ${raw}`);
    const { type, subtype } = envelope.data;
    const lineType = subtype === undefined ? type : `${type}/${subtype}`;
    return otherLine(lineType, lineType);
  }

  return {
    parseLine(raw) {
      return { ...parse(raw), payload: raw };
    },
  };
}
