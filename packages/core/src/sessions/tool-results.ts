import { z } from "zod";
import {
  diffCounts,
  editResultSchema,
  lineDiff,
  patchLines,
  plural,
  splitLines,
} from "../contracts/index.js";
import type { PatchHunk } from "../contracts/index.js";
import { displayPath, firstLine } from "./summary.js";

export interface ToolUse {
  name: string;
  input: Record<string, unknown>;
  filePath: string | null;
}

const keptLines = 40;
const keptPatchLines = 400;
const keptLineLength = 400;

// These results echo file contents that the tool input already shows, so none of their output is kept.
const quietTools = new Set(["Read", "NotebookRead", "Edit", "MultiEdit", "Write", "NotebookEdit"]);

const editSchema = z.object({ old_string: z.string(), new_string: z.string() });
const multiEditSchema = z.object({ edits: z.array(editSchema) });
const writeSchema = z.object({ content: z.string() });
const numberedLine = /^\s*\d+[→\t]/;

const clipped = (line: string): string =>
  line.length > keptLineLength ? `${line.slice(0, keptLineLength - 1)}…` : line;

export function keptOutput(toolName: string | null, output: string): string {
  if (toolName !== null && quietTools.has(toolName)) return "";
  const lines = splitLines(output);
  const kept = lines.slice(0, keptLines).map(clipped);
  const hidden = lines.length - kept.length;
  return (hidden > 0 ? [...kept, `… +${plural(hidden, "line")}`] : kept).join("\n");
}

export function keptPatch(toolUseResult: unknown): PatchHunk[] | null {
  const result = editResultSchema.safeParse(toolUseResult);
  if (!result.success) return null;
  const kept: PatchHunk[] = [];
  let room = keptPatchLines;
  for (const hunk of result.data.structuredPatch) {
    if (room <= 0) break;
    kept.push({ ...hunk, lines: hunk.lines.slice(0, room) });
    room -= hunk.lines.length;
  }
  return kept;
}

function editSummary(path: string, counts: { added: number; removed: number }): string {
  const changes = [
    counts.added > 0 ? plural(counts.added, "addition") : null,
    counts.removed > 0 ? plural(counts.removed, "removal") : null,
  ].filter((part) => part !== null);
  return changes.length === 0 ? `Updated ${path}` : `Updated ${path} with ${changes.join(" and ")}`;
}

function inputCounts(edits: readonly z.infer<typeof editSchema>[]) {
  return diffCounts(edits.flatMap((edit) => lineDiff(edit.old_string, edit.new_string)));
}

// Claude Code's own one-line account of a finished tool call, as shown under the call.
export function resultSummary(
  tool: ToolUse | null,
  output: string,
  cwd: string | null,
  patch: readonly PatchHunk[] | null,
): string {
  const path = tool?.filePath === null || tool === null ? "" : displayPath(tool.filePath, cwd);
  const outputLines = splitLines(output);
  switch (tool?.name) {
    case "Read":
      return `Read ${plural(outputLines.filter((line) => numberedLine.test(line)).length, "line")}`;
    case "Write": {
      const write = writeSchema.safeParse(tool.input);
      if (write.success)
        return `Wrote ${plural(splitLines(write.data.content).length, "line")} to ${path}`;
      break;
    }
    case "Edit": {
      if (patch !== null && patch.length > 0)
        return editSummary(path, diffCounts(patchLines(patch)));
      const edit = editSchema.safeParse(tool.input);
      if (edit.success) return editSummary(path, inputCounts([edit.data]));
      break;
    }
    case "MultiEdit": {
      if (patch !== null && patch.length > 0)
        return editSummary(path, diffCounts(patchLines(patch)));
      const multi = multiEditSchema.safeParse(tool.input);
      if (multi.success) return editSummary(path, inputCounts(multi.data.edits));
      break;
    }
    case "Glob":
      if (!output.startsWith("No files found"))
        return `Found ${plural(outputLines.filter((line) => line.trim() !== "").length, "file")}`;
      break;
  }
  return firstLine(output) || "(No output)";
}
