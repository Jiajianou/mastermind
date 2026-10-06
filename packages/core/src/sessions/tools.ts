import type { EventType } from "../contracts/index.js";
import { displayPath, firstLine } from "./summary.js";

export interface ToolCall {
  type: EventType;
  name: string;
  summary: string;
  filePath: string | null;
  command: string | null;
}

const editTools = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const pathReadTools = new Set(["Read", "LS", "NotebookRead"]);
const patternReadTools = new Set(["Grep", "Glob"]);

export const isEditTool = (name: string): boolean => editTools.has(name);

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" ? value : null;
}

function quoted(value: string | null): string {
  return value === null ? "" : ` "${value}"`;
}

export function describeToolUse(
  name: string,
  input: Record<string, unknown>,
  cwd: string | null,
): ToolCall {
  const filePath =
    stringField(input, "file_path") ??
    stringField(input, "notebook_path") ??
    stringField(input, "path");
  const command = stringField(input, "command");
  const call = { name, filePath, command };
  const target = filePath === null ? "" : ` ${displayPath(filePath, cwd)}`;

  if (name === "Bash") {
    return { ...call, type: "run", summary: `Run ${firstLine(command ?? "")}` };
  }
  if (editTools.has(name)) return { ...call, type: "edit", summary: `${name}${target}` };
  if (pathReadTools.has(name)) return { ...call, type: "read", summary: `${name}${target}` };
  if (patternReadTools.has(name)) {
    return { ...call, type: "read", summary: `${name}${quoted(stringField(input, "pattern"))}` };
  }
  if (name === "WebFetch") {
    return { ...call, type: "read", summary: `WebFetch ${stringField(input, "url") ?? ""}` };
  }
  if (name === "WebSearch") {
    return { ...call, type: "read", summary: `WebSearch${quoted(stringField(input, "query"))}` };
  }
  if (name.startsWith("mcp__")) return { ...call, type: "read", summary: name };
  if (name === "StructuredOutput") return { ...call, type: "note", summary: "Structured output" };
  return { ...call, type: "note", summary: name };
}
