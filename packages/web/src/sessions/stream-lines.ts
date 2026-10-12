import { streamLineSchema } from "@mastermind/core/contracts";
import type { SessionEvent, StreamLine } from "@mastermind/core/contracts";

// Stored events never change, so each payload is parsed once however often the transcript grows.
const parsedLines = new WeakMap<SessionEvent, StreamLine | null>();

function parsePayload(payload: string): StreamLine | null {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  const parsed = streamLineSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function streamLine(event: SessionEvent): StreamLine | null {
  const cached = parsedLines.get(event);
  if (cached !== undefined) return cached;
  const line = parsePayload(event.payload);
  parsedLines.set(event, line);
  return line;
}
