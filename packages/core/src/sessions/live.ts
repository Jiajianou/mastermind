import type { SessionLive } from "../contracts/index.js";
import type { EventDetails } from "./parser.js";

export function liveUpdate(details: EventDetails): SessionLive | null {
  if (details.line === "thinking") return { kind: "thinking", tokens: details.tokens };
  if (details.line !== "partial") return null;
  const { blockStart, textDelta } = details;
  if (blockStart?.type === "thinking") return { kind: "thinking", tokens: 0 };
  if (blockStart?.type === "tool_use" && blockStart.name !== null)
    return { kind: "tool", name: blockStart.name };
  return textDelta === null || textDelta === "" ? null : { kind: "text", delta: textDelta };
}
