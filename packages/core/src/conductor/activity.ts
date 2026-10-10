import { displayPath } from "../sessions/summary.js";
import { actionTools } from "./tools.js";

const mastermindPrefix = "mcp__mastermind__";
const searchTools: ReadonlySet<string> = new Set(["Grep", "Glob"]);

function mastermindActivity(tool: string): string {
  if (tool === "propose_plan") return "Drafting a plan";
  if (actionTools.some(({ name }) => name === tool)) return "Making changes";
  return "Checking the project";
}

export function toolActivity(toolName: string, filePath: string | null, repoRoot: string): string {
  if (toolName === "Read" && filePath !== null) return `Reading ${displayPath(filePath, repoRoot)}`;
  if (searchTools.has(toolName)) return "Searching the code";
  if (toolName.startsWith(mastermindPrefix))
    return mastermindActivity(toolName.slice(mastermindPrefix.length));
  return "Working";
}
