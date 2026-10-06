import { streamLineSchema } from "@mastermind/core/contracts";
import type { SessionEvent, StreamLine } from "@mastermind/core/contracts";
import { z } from "zod";

export interface FileChange {
  path: string;
  added: number;
  removed: number;
}

export interface SessionActivity {
  latest: SessionEvent | null;
  files: FileChange[];
  commits: number;
  contextTokens: number | null;
}

const editInputSchema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
});
const multiEditInputSchema = z.object({
  file_path: z.string(),
  edits: z.array(z.object({ old_string: z.string(), new_string: z.string() })),
});
const writeInputSchema = z.object({ file_path: z.string(), content: z.string() });
const pathInputSchema = z.union([
  z.object({ file_path: z.string() }).transform((input) => input.file_path),
  z.object({ notebook_path: z.string() }).transform((input) => input.notebook_path),
]);

// Stored events never change, so each payload is parsed once however often the timeline grows.
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

function streamLine(event: SessionEvent): StreamLine | null {
  const cached = parsedLines.get(event);
  if (cached !== undefined) return cached;
  const line = parsePayload(event.payload);
  parsedLines.set(event, line);
  return line;
}

function lineCount(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function toolInput(line: StreamLine | null): { name: string; input: unknown } | null {
  if (line?.type !== "assistant") return null;
  const block = line.message.content.find((content) => content.type === "tool_use");
  return block === undefined ? null : { name: block.name, input: block.input };
}

function editChange(name: string, input: unknown): FileChange | null {
  if (name === "Edit") {
    const edit = editInputSchema.safeParse(input);
    if (edit.success)
      return {
        path: edit.data.file_path,
        added: lineCount(edit.data.new_string),
        removed: lineCount(edit.data.old_string),
      };
  }
  if (name === "MultiEdit") {
    const multi = multiEditInputSchema.safeParse(input);
    if (multi.success)
      return {
        path: multi.data.file_path,
        added: multi.data.edits.reduce((sum, edit) => sum + lineCount(edit.new_string), 0),
        removed: multi.data.edits.reduce((sum, edit) => sum + lineCount(edit.old_string), 0),
      };
  }
  if (name === "Write") {
    const write = writeInputSchema.safeParse(input);
    if (write.success)
      return { path: write.data.file_path, added: lineCount(write.data.content), removed: 0 };
  }
  const path = pathInputSchema.safeParse(input);
  return path.success ? { path: path.data, added: 0, removed: 0 } : null;
}

function relativeTo(cwd: string | null, path: string): string {
  if (cwd === null) return path;
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function contextOf(line: StreamLine | null): number | null {
  if (line?.type !== "assistant") return null;
  const usage = line.message.usage;
  if (usage === null || usage === undefined) return null;
  return (
    usage.input_tokens +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

export function sessionActivity(events: readonly SessionEvent[]): SessionActivity {
  let cwd: string | null = null;
  let contextTokens: number | null = null;
  let commits = 0;
  const files = new Map<string, FileChange>();
  for (const event of events) {
    const line = streamLine(event);
    if (line?.type === "system" && line.subtype === "init") cwd ??= line.cwd;
    contextTokens = contextOf(line) ?? contextTokens;
    if (event.type === "commit") commits += 1;
    const tool = event.type === "edit" ? toolInput(line) : null;
    const change = tool === null ? null : editChange(tool.name, tool.input);
    if (change === null) continue;
    const path = relativeTo(cwd, change.path);
    const known = files.get(path);
    files.set(path, {
      path,
      added: (known?.added ?? 0) + change.added,
      removed: (known?.removed ?? 0) + change.removed,
    });
  }
  return { latest: events.at(-1) ?? null, files: [...files.values()], commits, contextTokens };
}

function initCwd(events: readonly SessionEvent[]): string | null {
  for (const event of events) {
    const line = streamLine(event);
    if (line?.type === "system" && line.subtype === "init") return line.cwd;
  }
  return null;
}

export function lastEditedPath(events: readonly SessionEvent[]): string | null {
  const edit = events.findLast((event) => event.type === "edit");
  const tool = edit === undefined ? null : toolInput(streamLine(edit));
  const change = tool === null ? null : editChange(tool.name, tool.input);
  return change === null ? null : relativeTo(initCwd(events), change.path);
}

export function contextWindow(model: string | null): number {
  return model?.includes("[1m]") === true ? 1_000_000 : 200_000;
}
