import { awaitingConfirmationSchema } from "../contracts/index.js";
import { joinPhrases } from "./format.js";
import { actionTools } from "./tools.js";

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  isError: boolean;
  output: string;
}

const toolPrefix = "mcp__mastermind__";

function parseOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function donePhrase(call: ToolCallRecord): string | null {
  if (call.isError || !call.name.startsWith(toolPrefix)) return null;
  const result = parseOutput(call.output);
  if (awaitingConfirmationSchema.safeParse(result).success) return null;
  const toolName = call.name.slice(toolPrefix.length);
  const tool = actionTools.find((candidate) => candidate.name === toolName);
  return tool === undefined ? null : tool.done(call.input, result);
}

export function summariseActions(calls: readonly ToolCallRecord[]): string | null {
  const phrases = [...new Set(calls.flatMap((call) => donePhrase(call) ?? []))];
  return phrases.length === 0 ? null : `✓ ${joinPhrases(phrases)}`;
}
