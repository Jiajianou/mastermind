import {
  editResultSchema,
  hunkGap,
  lineDiff,
  patchLines,
  plural,
  splitLines,
} from "@mastermind/core/contracts";
import type {
  DiffLine,
  NumberedDiffLine,
  PatchHunk,
  SessionEvent,
  StreamContentBlock,
} from "@mastermind/core/contracts";
import { z } from "zod";
import { streamLine } from "./stream-lines.js";

export type ToolStatus = "running" | "done" | "failed" | "unfinished";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
}

export type ToolDetail =
  | { kind: "diff"; lines: NumberedDiffLine[]; hidden: number }
  | { kind: "todos"; todos: Todo[] }
  | { kind: "output"; text: string }
  | { kind: "none" };

export type TranscriptEntry =
  | { kind: "prompt"; key: string; text: string; fromOwner: boolean }
  | { kind: "text"; key: string; text: string }
  | {
      kind: "tool";
      key: string;
      name: string;
      target: string;
      status: ToolStatus;
      result: string | null;
      detail: ToolDetail;
    }
  | { kind: "notice"; key: string; text: string; failed: boolean };

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;
type ToolUseBlock = Extract<StreamContentBlock, { type: "tool_use" }>;

const maxDiffLines = 200;

const pathInputSchema = z.object({
  file_path: z.string().optional(),
  notebook_path: z.string().optional(),
  path: z.string().optional(),
});
const textInputSchema = z.object({
  command: z.string().optional(),
  pattern: z.string().optional(),
  url: z.string().optional(),
  query: z.string().optional(),
  description: z.string().optional(),
});
const editSchema = z.object({ old_string: z.string(), new_string: z.string() });
const multiEditSchema = z.object({ edits: z.array(editSchema) });
const writeSchema = z.object({ content: z.string() });
const todoWriteSchema = z.object({
  todos: z.array(
    z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) }),
  ),
});
const toolNames: Readonly<Record<string, string>> = {
  Edit: "Update",
  MultiEdit: "Update",
  NotebookEdit: "Update",
  Grep: "Search",
  Glob: "Search",
  LS: "List",
  WebFetch: "Fetch",
  WebSearch: "Web Search",
  TodoWrite: "Update Todos",
  Agent: "Task",
};

function relative(path: string, cwd: string | null): string {
  return cwd !== null && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function commandLine(command: string): string {
  const [first = ""] = splitLines(command.trim());
  return command.trim().includes("\n") ? `${first} …` : first;
}

function toolTarget(name: string, input: unknown, cwd: string | null): string {
  const paths = pathInputSchema.safeParse(input).data;
  const text = textInputSchema.safeParse(input).data;
  const path = paths?.file_path ?? paths?.notebook_path ?? null;
  switch (name) {
    case "Bash":
      return commandLine(text?.command ?? "");
    case "Grep":
    case "Glob": {
      const where = paths?.path === undefined ? "" : `, path: "${relative(paths.path, cwd)}"`;
      return `pattern: "${text?.pattern ?? ""}"${where}`;
    }
    case "LS":
      return relative(paths?.path ?? "", cwd);
    case "WebFetch":
      return text?.url ?? "";
    case "WebSearch":
      return `"${text?.query ?? ""}"`;
    case "Task":
    case "Agent":
      return text?.description ?? "";
  }
  return path === null ? "" : relative(path, cwd);
}

function toolName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp !== null) return `${mcp[1] ?? ""} - ${mcp[2] ?? ""} (MCP)`;
  return toolNames[name] ?? name;
}

const unnumbered = (lines: readonly DiffLine[]): NumberedDiffLine[] =>
  lines.map((line) => ({ ...line, number: null }));

const numberedFromOne = (lines: readonly DiffLine[]): NumberedDiffLine[] =>
  lines.map((line, index) => ({ ...line, number: index + 1 }));

function cappedDiff(lines: NumberedDiffLine[]): ToolDetail {
  return {
    kind: "diff",
    lines: lines.slice(0, maxDiffLines),
    hidden: Math.max(0, lines.length - maxDiffLines),
  };
}

function inputDetail(name: string, input: unknown): ToolDetail {
  if (name === "Edit") {
    const edit = editSchema.safeParse(input);
    if (edit.success)
      return cappedDiff(unnumbered(lineDiff(edit.data.old_string, edit.data.new_string)));
  }
  if (name === "MultiEdit") {
    const multi = multiEditSchema.safeParse(input);
    if (multi.success)
      return cappedDiff(
        multi.data.edits.flatMap((edit, index) => [
          ...(index === 0 ? [] : [hunkGap]),
          ...unnumbered(lineDiff(edit.old_string, edit.new_string)),
        ]),
      );
  }
  if (name === "Write") {
    const write = writeSchema.safeParse(input);
    if (write.success) return cappedDiff(numberedFromOne(lineDiff("", write.data.content)));
  }
  if (name === "TodoWrite") {
    const todos = todoWriteSchema.safeParse(input);
    if (todos.success) return { kind: "todos", todos: todos.data.todos };
  }
  return { kind: "none" };
}

function toolEntry(block: ToolUseBlock, cwd: string | null): ToolEntry {
  return {
    kind: "tool",
    key: `tool-${block.id}`,
    name: toolName(block.name),
    target: toolTarget(block.name, block.input, cwd),
    status: "unfinished",
    result: null,
    detail: inputDetail(block.name, block.input),
  };
}

function blocksText(content: string | readonly StreamContentBlock[] | null | undefined): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function resultText(content: string | readonly unknown[] | null | undefined): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .flatMap((block) => {
      const text = z.object({ text: z.string() }).safeParse(block);
      return text.success ? [text.data.text] : [];
    })
    .join("\n");
}

interface Finished {
  toolUseId: string;
  output: string;
  patch: PatchHunk[];
}

function finishedTool(event: SessionEvent): Finished | null {
  const line = streamLine(event);
  if (line?.type === "system" && line.subtype === "permission_denied")
    return line.tool_use_id === null || line.tool_use_id === undefined
      ? null
      : { toolUseId: line.tool_use_id, output: line.message, patch: [] };
  if (line?.type !== "user" || typeof line.message.content === "string") return null;
  const block = line.message.content.find((content) => content.type === "tool_result");
  if (block === undefined) return null;
  const patch = editResultSchema.safeParse(line.tool_use_result).data?.structuredPatch ?? [];
  return { toolUseId: block.tool_use_id, output: resultText(block.content), patch };
}

// Claude Code's own patch numbers the lines and shows their context, so it replaces the diff built from the input.
function finish(tool: ToolEntry, event: SessionEvent, { output, patch }: Finished): void {
  tool.status = event.type === "error" ? "failed" : "done";
  tool.result = event.summary;
  if (patch.length > 0) tool.detail = cappedDiff(patchLines(patch));
  const shown = event.type === "commit" ? "" : output.trim();
  if (tool.detail.kind === "none" && shown !== "" && shown !== tool.result)
    tool.detail = { kind: "output", text: shown };
}

export function sessionTranscript(
  events: readonly SessionEvent[],
  running: boolean,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const tools = new Map<string, ToolEntry>();
  let cwd: string | null = null;
  const notice = (event: SessionEvent, failed: boolean) =>
    entries.push({ kind: "notice", key: `event-${String(event.id)}`, text: event.summary, failed });

  for (const event of events) {
    const line = streamLine(event);
    if (line?.type === "system" && line.subtype === "init") cwd ??= line.cwd;
    if (event.type === "start" || event.type === "result") continue;

    if (event.type === "prompt" || event.type === "steer") {
      const text = line?.type === "user" ? blocksText(line.message.content) : "";
      entries.push({
        kind: "prompt",
        key: `event-${String(event.id)}`,
        text: text === "" ? event.summary : text,
        fromOwner: event.type === "steer",
      });
      continue;
    }

    if (line?.type === "assistant" && (line.error ?? null) === null) {
      const text = blocksText(line.message.content).trim();
      if (text !== "") entries.push({ kind: "text", key: `event-${String(event.id)}`, text });
      for (const block of line.message.content)
        if (block.type === "tool_use") {
          const tool = toolEntry(block, cwd);
          tools.set(block.id, tool);
          entries.push(tool);
        }
      continue;
    }

    const finished = finishedTool(event);
    const tool = finished === null ? undefined : tools.get(finished.toolUseId);
    if (finished !== null && tool !== undefined) finish(tool, event, finished);
    else if (event.type !== "output") notice(event, event.type === "error");
  }

  if (running)
    for (const tool of tools.values()) if (tool.status === "unfinished") tool.status = "running";
  return entries;
}

export function startingTool(name: string): Extract<TranscriptEntry, { kind: "tool" }> {
  return {
    kind: "tool",
    key: "starting-tool",
    name: toolName(name),
    target: "",
    status: "running",
    result: null,
    detail: { kind: "none" },
  };
}

export function hiddenLinesNote(hidden: number): string {
  return `… +${plural(hidden, "line")}`;
}

export function workingSince(
  events: readonly SessionEvent[],
  running: boolean,
  startedAt: string,
): string | null {
  if (!running) return null;
  const turn = events.findLast((event) => event.type === "prompt" || event.type === "steer");
  return turn?.ts ?? startedAt;
}
