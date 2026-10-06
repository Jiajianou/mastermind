import { Document, isMap, isSeq, parseDocument } from "yaml";
import {
  createTasksInputSchema,
  importTasksInputSchema,
  isPlainRecord,
  newTaskSchema,
  noInputSchema,
  plural,
} from "../contracts/index.js";
import type { Task } from "../contracts/index.js";
import type { NewTask } from "../db/index.js";
import { ActionError } from "./errors.js";
import { defineAction, parseInput } from "./registry.js";
import { insertTaskBatch } from "./tasks.js";

const taskKeys = new Set<string>(newTaskSchema.keyof().options);

export interface TasksFile {
  tasks: NewTask[];
  warnings: string[];
}

function topLevelEntries(content: unknown, warnings: string[]): unknown {
  if (!isPlainRecord(content)) return content;
  for (const key of Object.keys(content)) {
    if (key !== "tasks") warnings.push(`ignored unknown top-level key "${key}"`);
  }
  return content.tasks;
}

function knownTaskFields(entries: unknown, warnings: string[]): unknown {
  if (!Array.isArray(entries)) return entries;
  const ignoredCounts = new Map<string, number>();
  const tasks = entries.map((entry: unknown) => {
    if (!isPlainRecord(entry)) return entry;
    const known = Object.entries(entry).filter(([key]) => taskKeys.has(key));
    for (const key of Object.keys(entry).filter((key) => !taskKeys.has(key))) {
      ignoredCounts.set(key, (ignoredCounts.get(key) ?? 0) + 1);
    }
    return Object.fromEntries(known);
  });
  for (const [key, count] of ignoredCounts) {
    warnings.push(`ignored unknown key "${key}" (${plural(count, "task")})`);
  }
  return tasks;
}

export function parseTasksYaml(text: string): TasksFile {
  const document = parseDocument(text);
  const [syntaxError] = document.errors;
  if (syntaxError !== undefined) {
    throw ActionError.fromMessage("invalid_input", `tasks.yaml: ${syntaxError.message}`);
  }
  const warnings: string[] = [];
  const entries = topLevelEntries(document.toJS(), warnings);
  const { tasks } = parseInput(createTasksInputSchema, {
    tasks: knownTaskFields(entries, warnings),
  });
  return { tasks, warnings };
}

export function tasksToYaml(tasks: readonly Task[]): string {
  const document = new Document({
    tasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      ...(task.priority === 0 ? {} : { priority: task.priority }),
      deps: task.deps,
      touches: task.touches,
      goal: task.goal,
      acceptance: task.acceptance,
    })),
  });
  const entries = document.get("tasks");
  if (isSeq(entries)) {
    for (const entry of entries.items) {
      if (!isMap(entry)) continue;
      for (const key of ["deps", "touches"]) {
        const list = entry.get(key, true);
        if (isSeq(list)) list.flow = true;
      }
    }
  }
  return document.toString({ lineWidth: 0, blockQuote: "literal" });
}

export const importTasks = defineAction({
  name: "importTasks",
  description:
    "Create tasks from the text of a tasks.yaml file (a list of tasks, or a mapping with a tasks list). Unknown keys are ignored and reported as warnings; the import is rejected as a whole on a duplicate id, an unknown dependency or a cycle.",
  input: importTasksInputSchema,
  emits: ["task.updated"],
  handler: ({ yaml }, scope): { tasks: Task[]; warnings: string[] } => {
    const { tasks, warnings } = parseTasksYaml(yaml);
    return { tasks: insertTaskBatch(scope, tasks), warnings };
  },
});

export const exportTasks = defineAction({
  name: "exportTasks",
  description: "Write every task as the text of a tasks.yaml file.",
  input: noInputSchema,
  emits: [],
  handler: (_input, { db }) => ({ yaml: tasksToYaml(db.tasks.list()) }),
});
