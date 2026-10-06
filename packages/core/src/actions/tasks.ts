import { z } from "zod";
import { newTaskSchema, taskEditSchema, taskIdSchema } from "../contracts/index.js";
import type { Task } from "../contracts/index.js";
import type { NewTask, TaskPatch } from "../db/index.js";
import { describeGraphIssue, findGraphIssues } from "./dag.js";
import type { GraphIssue } from "./dag.js";
import { ActionError } from "./errors.js";
import { defineAction } from "./registry.js";
import type { ActionScope } from "./registry.js";
import { assertTransition } from "./transitions.js";

type TaskScope = ActionScope<"task.updated">;

const taskRefSchema = z.strictObject({ taskId: taskIdSchema });

function hasChanges(input: Record<string, unknown>): boolean {
  return Object.entries(input).some(([key, value]) => key !== "taskId" && value !== undefined);
}

function graphError(issues: readonly GraphIssue[]): ActionError {
  return new ActionError(
    "invalid_input",
    issues.map((issue) => ({ path: null, message: describeGraphIssue(issue) })),
  );
}

function requireTask({ db }: TaskScope, taskId: string): Task {
  const task = db.tasks.get(taskId);
  if (task === null) throw ActionError.fromMessage("not_found", `no task "${taskId}"`);
  return task;
}

function updateTaskRow(scope: TaskScope, taskId: string, patch: TaskPatch): Task {
  const task = scope.db.tasks.update(taskId, patch);
  scope.emit({ type: "task.updated", taskId, task });
  return task;
}

export function insertTaskBatch(scope: TaskScope, batch: readonly NewTask[]): Task[] {
  const { db } = scope;
  const created = db.transaction(() => {
    const issues = findGraphIssues(
      batch.map((task) => ({ id: task.id, deps: task.deps ?? [] })),
      db.tasks.list(),
    );
    if (issues.length > 0) throw graphError(issues);
    return batch.map((task) => db.tasks.create(task));
  });
  for (const task of created) scope.emit({ type: "task.updated", taskId: task.id, task });
  return created;
}

export const createTasks = defineAction({
  name: "createTasks",
  description:
    "Create a batch of tasks at once. The batch may reference its own tasks and existing ones in deps, and is rejected as a whole on a duplicate id, an unknown dependency or a cycle.",
  input: z.strictObject({ tasks: z.array(newTaskSchema).min(1) }),
  emits: ["task.updated"],
  handler: ({ tasks }, scope) => insertTaskBatch(scope, tasks),
});

export const updateTask = defineAction({
  name: "updateTask",
  description:
    "Change a task's title, goal, acceptance command, touches, deps or priority. New deps must exist and must not form a cycle.",
  input: taskEditSchema
    .extend({ taskId: taskIdSchema })
    .refine(hasChanges, { error: "expected at least one field to change" }),
  emits: ["task.updated"],
  handler: ({ taskId, ...changes }, scope) => {
    const { db } = scope;
    const task = db.transaction(() => {
      requireTask(scope, taskId);
      if (changes.deps !== undefined) {
        const others = db.tasks.list().filter((other) => other.id !== taskId);
        const issues = findGraphIssues([{ id: taskId, deps: changes.deps }], others);
        if (issues.length > 0) throw graphError(issues);
      }
      return db.tasks.update(taskId, changes);
    });
    scope.emit({ type: "task.updated", taskId, task });
    return task;
  },
});

export const setPriority = defineAction({
  name: "setPriority",
  description: "Set a task's priority. Higher numbers start first.",
  input: z.strictObject({ taskId: taskIdSchema, priority: z.int() }),
  emits: ["task.updated"],
  handler: ({ taskId, priority }, scope) => {
    requireTask(scope, taskId);
    return updateTaskRow(scope, taskId, { priority });
  },
});

export const moveToTop = defineAction({
  name: "moveToTop",
  description: "Give a task a higher priority than every other unfinished task.",
  input: taskRefSchema,
  emits: ["task.updated"],
  handler: ({ taskId }, scope) => {
    const task = requireTask(scope, taskId);
    const otherPriorities = scope.db.tasks
      .list()
      .filter((other) => other.id !== taskId && other.status !== "done")
      .map((other) => other.priority);
    const highest = Math.max(...otherPriorities);
    if (task.priority > highest) return task;
    return updateTaskRow(scope, taskId, { priority: highest + 1 });
  },
});

export const hold = defineAction({
  name: "hold",
  description: "Hold a task so the scheduler does not start it. Running work is not stopped.",
  input: taskRefSchema,
  emits: ["task.updated"],
  handler: ({ taskId }, scope) => {
    requireTask(scope, taskId);
    return updateTaskRow(scope, taskId, { held: true });
  },
});

export const release = defineAction({
  name: "release",
  description: "Release a held task so the scheduler may start it again.",
  input: taskRefSchema,
  emits: ["task.updated"],
  handler: ({ taskId }, scope) => {
    requireTask(scope, taskId);
    return updateTaskRow(scope, taskId, { held: false });
  },
});

export const retry = defineAction({
  name: "retry",
  description: "Return a blocked task to the queue with a fresh set of attempts.",
  input: taskRefSchema,
  emits: ["task.updated"],
  handler: ({ taskId }, scope) => {
    const task = requireTask(scope, taskId);
    assertTransition(taskId, task.status, "pending");
    return updateTaskRow(scope, taskId, { status: "pending", attempts: 0 });
  },
});
