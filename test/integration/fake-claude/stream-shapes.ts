import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

type JsonType = "null" | "boolean" | "number" | "string" | "array" | "object";

interface Shape {
  types: Set<JsonType>;
  keys: Map<string, Shape>;
  required: Set<string> | undefined;
  items: Shape | undefined;
}

const recordPaths = new Set(["modelUsage", "wire_tool_inputs", "subagent_stats.by_type"]);
const freeFormKinds = /StructuredOutput|mcp/;
const freeFormPaths = new Set([
  "message.content[].input",
  "event.content_block.input",
  "structured_output",
  "tool_use_result",
  "wire_tool_inputs.*",
]);

const lineSchema = z.looseObject({ type: z.string(), subtype: z.string().optional() });
const blockSchema = z.looseObject({
  type: z.string(),
  name: z.string().optional(),
  id: z.string().optional(),
  tool_use_id: z.string().optional(),
});
const messageSchema = z.looseObject({ content: z.union([z.string(), z.array(blockSchema)]) });
const eventSchema = z.looseObject({
  type: z.string(),
  delta: z.looseObject({ type: z.string().optional() }).optional(),
  content_block: z.looseObject({ type: z.string() }).optional(),
});

const emptyShape = (): Shape => ({
  types: new Set(),
  keys: new Map(),
  required: undefined,
  items: undefined,
});

function jsonType(value: unknown): JsonType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string") return type;
  return "object";
}

function entriesOf(value: unknown): [string, unknown][] {
  return typeof value === "object" && value !== null ? Object.entries(value) : [];
}

function isFreeForm(kind: string, path: string): boolean {
  return freeFormKinds.test(kind) && freeFormPaths.has(path);
}

function childPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

function addValue(shape: Shape, value: unknown, kind: string, path: string): void {
  const type = jsonType(value);
  shape.types.add(type);
  if (type === "array" && Array.isArray(value)) {
    shape.items ??= emptyShape();
    for (const item of value) addValue(shape.items, item, kind, `${path}[]`);
    return;
  }
  if (type !== "object" || isFreeForm(kind, path)) return;
  const entries = entriesOf(value);
  const isRecord = recordPaths.has(path);
  if (!isRecord) {
    const present = new Set(entries.map(([key]) => key));
    shape.required =
      shape.required === undefined
        ? present
        : new Set([...shape.required].filter((key) => present.has(key)));
  }
  for (const [key, child] of entries) {
    const name = isRecord ? "*" : key;
    const childShape = shape.keys.get(name) ?? emptyShape();
    shape.keys.set(name, childShape);
    addValue(childShape, child, kind, isRecord ? `${path}.*` : childPath(path, key));
  }
}

function conformanceProblems(
  value: unknown,
  shape: Shape,
  kind: string,
  path: string,
  problems: string[],
): void {
  const type = jsonType(value);
  const at = `${kind} ${path === "" ? "(line)" : path}`;
  if (!shape.types.has(type)) {
    problems.push(`${at}: ${type} where the samples have ${[...shape.types].join(" | ")}`);
    return;
  }
  if (type === "array" && Array.isArray(value)) {
    for (const item of value) {
      if (shape.items === undefined) problems.push(`${at}: items where the samples have none`);
      else conformanceProblems(item, shape.items, kind, `${path}[]`, problems);
    }
    return;
  }
  if (type !== "object" || isFreeForm(kind, path)) return;
  const entries = entriesOf(value);
  const isRecord = recordPaths.has(path);
  if (!isRecord) {
    const present = new Set(entries.map(([key]) => key));
    for (const key of shape.required ?? []) {
      if (!present.has(key)) problems.push(`${at}: missing ${key}`);
    }
  }
  for (const [key, child] of entries) {
    const childShape = shape.keys.get(isRecord ? "*" : key);
    if (childShape === undefined) problems.push(`${at}: unexpected ${key}`);
    else {
      const nextPath = isRecord ? `${path}.*` : childPath(path, key);
      conformanceProblems(child, childShape, kind, nextPath, problems);
    }
  }
}

export class LineKinds {
  private readonly toolNames = new Map<string, string>();

  kindOf(line: unknown): string {
    const { type, subtype } = lineSchema.parse(line);
    const parts = [type, subtype ?? ""];
    const fields = Object.fromEntries(entriesOf(line));
    if (fields.isReplay === true) parts.push("replay");
    if (fields.error !== undefined) parts.push("error");

    const message = messageSchema.safeParse(fields.message);
    if (message.success) {
      const content = message.data.content;
      const block = typeof content === "string" ? undefined : content[0];
      parts.push(block?.type ?? "string");
      if (block?.type === "tool_use" && block.id !== undefined) {
        this.toolNames.set(block.id, block.name ?? "");
      }
      const toolName =
        block?.type === "tool_use"
          ? block.name
          : block?.tool_use_id === undefined
            ? undefined
            : this.toolNames.get(block.tool_use_id);
      if (toolName !== undefined) parts.push(toolName.startsWith("mcp__") ? "mcp" : toolName);
    }

    const event = eventSchema.safeParse(fields.event);
    if (event.success) {
      parts.push(event.data.type, event.data.delta?.type ?? event.data.content_block?.type ?? "");
    }
    return parts.join("/");
  }
}

export class SampleShapes {
  private readonly shapes = new Map<string, Shape>();

  static fromDirectory(dir: string): SampleShapes {
    const samples = new SampleShapes();
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
      const kinds = new LineKinds();
      for (const line of readJsonLines(join(dir, file))) {
        const kind = kinds.kindOf(line);
        const shape = samples.shapes.get(kind) ?? emptyShape();
        samples.shapes.set(kind, shape);
        addValue(shape, line, kind, "");
      }
    }
    return samples;
  }

  problemsWith(lines: readonly unknown[]): string[] {
    const kinds = new LineKinds();
    const problems: string[] = [];
    for (const line of lines) {
      const kind = kinds.kindOf(line);
      const shape = this.shapes.get(kind);
      if (shape === undefined) problems.push(`${kind}: never recorded from the real CLI`);
      else conformanceProblems(line, shape, kind, "", problems);
    }
    return [...new Set(problems)];
  }
}

export function readJsonLines(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line): unknown => JSON.parse(line));
}
