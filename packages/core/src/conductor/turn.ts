import { contextTokens } from "../sessions/index.js";
import type { ParsedEvent } from "../sessions/index.js";

export type RecordedText = { kind: "delta"; text: string } | { kind: "block"; text: string };

export interface TurnRecorder {
  record(event: ParsedEvent): RecordedText | null;
  unfinished(): string;
  evidence(): ParsedEvent[];
  contextTokens(): number | null;
}

// Each text block streams as deltas and then arrives whole in its assistant line, which is when it is posted. A block
// cut short by Stop never gets that line, so its streamed text is kept for the stopped reply.
export function createTurnRecorder(): TurnRecorder {
  const evidence: ParsedEvent[] = [];
  let unfinished = "";
  let tokens: number | null = null;

  return {
    record(event) {
      const { details } = event;
      switch (details.line) {
        case "partial":
          if (details.textDelta === null || details.textDelta === "") return null;
          unfinished += details.textDelta;
          return { kind: "delta", text: details.textDelta };
        case "assistant":
          if (details.usage !== null) tokens = contextTokens(details.usage);
          if (details.text === null || details.text === "") return null;
          unfinished = "";
          return { kind: "block", text: details.text };
        case "tool_use":
          if (details.usage !== null) tokens = contextTokens(details.usage);
          return null;
        case "api_error":
        case "rate_limit":
          evidence.push(event);
          return null;
        default:
          return null;
      }
    },
    unfinished: () => unfinished,
    evidence: () => [...evidence],
    contextTokens: () => tokens,
  };
}
