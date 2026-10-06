import { pathInside } from "../git/index.js";
import type { EventDetails } from "./parser.js";
import { isEditTool } from "./tools.js";

export interface FileEdit {
  stage: "editing" | "written";
  path: string;
}

function edit(
  stage: FileEdit["stage"],
  filePath: string | null,
  roots: readonly string[],
): FileEdit | null {
  if (filePath === null) return null;
  for (const root of roots) {
    const path = pathInside(root, filePath);
    if (path !== null) return { stage, path };
  }
  return null;
}

// The tool_use line is printed before Claude Code applies the edit, so only a successful tool_result means the
// file on disk has changed.
export function fileEdit(details: EventDetails, roots: readonly string[]): FileEdit | null {
  if (details.line === "tool_use" && isEditTool(details.toolName))
    return edit("editing", details.filePath, roots);
  if (
    details.line === "tool_result" &&
    !details.isError &&
    details.toolName !== null &&
    isEditTool(details.toolName)
  )
    return edit("written", details.filePath, roots);
  return null;
}
