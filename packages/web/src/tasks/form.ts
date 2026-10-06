import { newTaskSchema, taskEditSchema } from "@mastermind/core/contracts";
import type { Task, TaskEdit } from "@mastermind/core/contracts";
import type { z } from "zod";

export interface TaskFormValues {
  id: string;
  title: string;
  goal: string;
  acceptance: string;
  touches: string;
  deps: string;
  priority: string;
}

export type TaskField = keyof TaskFormValues;

export type FieldIssues = Partial<Record<TaskField, string>>;

export type FormResult<Input> = { ok: true; input: Input } | { ok: false; issues: FieldIssues };

export type NewTask = z.output<typeof newTaskSchema>;

export const emptyTaskForm: TaskFormValues = {
  id: "",
  title: "",
  goal: "",
  acceptance: "",
  touches: "",
  deps: "",
  priority: "0",
};

export function taskFormValues(task: Task): TaskFormValues {
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    acceptance: task.acceptance,
    touches: task.touches.join("\n"),
    deps: task.deps.join("\n"),
    priority: String(task.priority),
  };
}

const listItems = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item !== "");

function editableInput(values: TaskFormValues) {
  const priority = values.priority.trim();
  return {
    title: values.title,
    goal: values.goal,
    acceptance: values.acceptance,
    touches: listItems(values.touches),
    deps: listItems(values.deps),
    priority: priority === "" ? Number.NaN : Number(priority),
  };
}

function isTaskField(key: PropertyKey | undefined): key is TaskField {
  return typeof key === "string" && Object.hasOwn(emptyTaskForm, key);
}

function fieldIssues(error: z.ZodError, input: Readonly<Record<string, unknown>>): FieldIssues {
  const issues: FieldIssues = {};
  for (const { path, message } of error.issues) {
    const [field, index] = path;
    if (!isTaskField(field) || issues[field] !== undefined) continue;
    const value = input[field];
    const item: unknown =
      Array.isArray(value) && typeof index === "number" ? value[index] : undefined;
    issues[field] = typeof item === "string" ? `${item}: ${message}` : message;
  }
  return issues;
}

function parsed<Output>(
  result: z.ZodSafeParseResult<Output>,
  input: Readonly<Record<string, unknown>>,
): FormResult<Output> {
  return result.success
    ? { ok: true, input: result.data }
    : { ok: false, issues: fieldIssues(result.error, input) };
}

export function parseNewTask(values: TaskFormValues): FormResult<NewTask> {
  const input = { id: values.id.trim(), ...editableInput(values) };
  return parsed(newTaskSchema.safeParse(input), input);
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index]);

// Diffing against the task as it was when editing began keeps a concurrent change to an untouched field intact.
export function parseTaskEdit(original: Task, values: TaskFormValues): FormResult<TaskEdit> {
  const input = editableInput(values);
  const result = parsed(taskEditSchema.required().safeParse(input), input);
  if (!result.ok) return result;
  const next = result.input;
  const edit: TaskEdit = {};
  if (next.title !== original.title) edit.title = next.title;
  if (next.goal !== original.goal) edit.goal = next.goal;
  if (next.acceptance !== original.acceptance) edit.acceptance = next.acceptance;
  if (!sameList(next.touches, original.touches)) edit.touches = next.touches;
  if (!sameList(next.deps, original.deps)) edit.deps = next.deps;
  if (next.priority !== original.priority) edit.priority = next.priority;
  return { ok: true, input: edit };
}
