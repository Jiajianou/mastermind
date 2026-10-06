import { contextTokens } from "../sessions/index.js";
import type { ParsedEvent } from "../sessions/index.js";
import type { ToolCallRecord } from "./action-line.js";

export interface TurnRecorder {
  record(event: ParsedEvent): string | null;
  reply(): string;
  toolCalls(): ToolCallRecord[];
  evidence(): ParsedEvent[];
  contextTokens(): number | null;
}

// Text blocks around tool calls are separate in the stream; the reply joins them as paragraphs, so the streamed
// deltas carry the same separator. A block cut short by Stop never gets its complete line, so its streamed text is
// kept as well.
export function createTurnRecorder(): TurnRecorder {
  const texts: string[] = [];
  const started = new Map<string, Pick<ToolCallRecord, "name" | "input">>();
  const calls: ToolCallRecord[] = [];
  const evidence: ParsedEvent[] = [];
  let streamed = false;
  let needsSeparator = false;
  let unfinished = "";
  let tokens: number | null = null;

  function delta(text: string | null): string | null {
    if (text === null || text === "") return null;
    const separated = needsSeparator ? `\n\n${text}` : text;
    needsSeparator = false;
    streamed = true;
    unfinished += text;
    return separated;
  }

  return {
    record(event) {
      const { details } = event;
      switch (details.line) {
        case "partial":
          return delta(details.textDelta);
        case "assistant":
          if (details.usage !== null) tokens = contextTokens(details.usage);
          if (details.text !== null && details.text !== "") {
            texts.push(details.text);
            needsSeparator = streamed;
            unfinished = "";
          }
          return null;
        case "tool_use":
          if (details.usage !== null) tokens = contextTokens(details.usage);
          started.set(details.toolUseId, { name: details.toolName, input: details.input });
          return null;
        case "tool_result": {
          const call = started.get(details.toolUseId);
          if (call !== undefined)
            calls.push({ ...call, isError: details.isError, output: details.output });
          return null;
        }
        case "api_error":
        case "rate_limit":
          evidence.push(event);
          return null;
        default:
          return null;
      }
    },
    reply: () => [...texts, ...(unfinished === "" ? [] : [unfinished])].join("\n\n"),
    toolCalls: () => [...calls],
    evidence: () => [...evidence],
    contextTokens: () => tokens,
  };
}
