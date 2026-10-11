import { awaitingConfirmationSchema } from "../contracts/index.js";
import { displayPath } from "../sessions/summary.js";
import { actionTools, askOwnerTool, readTools } from "./tools.js";

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  isError: boolean;
  output: string;
}

const mastermindPrefix = "mcp__mastermind__";

const ownTool = (name: string): string | null =>
  name.startsWith(mastermindPrefix) ? name.slice(mastermindPrefix.length) : null;

const stringInput = (input: Record<string, unknown>, field: string): string | null => {
  const value = input[field];
  return typeof value === "string" ? value : null;
};

function parseOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

// A plan or a question shows as its own card, so a step row for it would only repeat it.
export function showsOwnCard(toolName: string): boolean {
  const own = ownTool(toolName);
  return own === askOwnerTool || own === "propose_plan";
}

function runningOwnLabel(tool: string): string {
  if (tool === "propose_plan") return "Drafting a plan";
  if (tool === askOwnerTool) return "Asking you a question";
  if (actionTools.some(({ name }) => name === tool)) return "Making changes";
  return "Checking the project";
}

export function runningLabel(
  toolName: string,
  input: Record<string, unknown>,
  repoRoot: string,
): string {
  const path = stringInput(input, "file_path");
  const pattern = stringInput(input, "pattern");
  if (toolName === "Read")
    return path === null ? "Reading a file" : `Reading ${displayPath(path, repoRoot)}`;
  if (toolName === "Grep")
    return pattern === null ? "Searching the code" : `Searching for "${pattern}"`;
  if (toolName === "Glob")
    return pattern === null ? "Looking for files" : `Looking for files matching "${pattern}"`;
  const own = ownTool(toolName);
  return own === null ? "Working" : runningOwnLabel(own);
}

function finishedOwnLabel(tool: string, call: ToolCallRecord): string {
  const read = readTools.find(({ name }) => name === tool);
  if (read !== undefined) return read.step(call.input);
  const action = actionTools.find(({ name }) => name === tool);
  if (action === undefined) return "Worked";
  if (call.isError) return action.describe(call.input);
  const result = parseOutput(call.output);
  if (awaitingConfirmationSchema.safeParse(result).success)
    return `Asked you to confirm: ${action.describe(call.input)}`;
  return action.done(call.input, result);
}

export function finishedLabel(call: ToolCallRecord, repoRoot: string): string {
  const path = stringInput(call.input, "file_path");
  const pattern = stringInput(call.input, "pattern");
  if (call.name === "Read")
    return path === null ? "Read a file" : `Read ${displayPath(path, repoRoot)}`;
  if (call.name === "Grep")
    return pattern === null ? "Searched the code" : `Searched for "${pattern}"`;
  if (call.name === "Glob")
    return pattern === null ? "Looked for files" : `Looked for files matching "${pattern}"`;
  const own = ownTool(call.name);
  return own === null ? "Worked" : finishedOwnLabel(own, call);
}

// Mastermind's own tools answer in JSON meant for the model, so only Claude's file tools and failures show output.
export function stepDetail(call: ToolCallRecord): string | null {
  if (call.isError || ownTool(call.name) === null) return call.output === "" ? null : call.output;
  return null;
}
