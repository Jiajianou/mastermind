import type { AnyActionDefinition } from "./registry.js";
import { pause, resume, setConfig } from "./runtime.js";
import { exportTasks, importTasks } from "./tasks-file.js";
import { createTasks, hold, moveToTop, release, retry, setPriority, updateTask } from "./tasks.js";

export { describeGraphIssue, findGraphIssues } from "./dag.js";
export type { GraphIssue, GraphNode } from "./dag.js";
export { ActionError, IllegalTransitionError } from "./errors.js";
export { createActionRegistry, defineAction, parseInput } from "./registry.js";
export type {
  ActionContext,
  ActionDefinition,
  ActionInfo,
  ActionRegistry,
  ActionScope,
  AnyActionDefinition,
  ConfigWriter,
} from "./registry.js";
export { setBackoff } from "./runtime.js";
export type { SchedulerScope } from "./runtime.js";
export { readTasksFile, writeTasksFile } from "./tasks-file.js";
export type { TasksFile } from "./tasks-file.js";
export { assertTransition, canTransition } from "./transitions.js";
export {
  createTasks,
  exportTasks,
  hold,
  importTasks,
  moveToTop,
  pause,
  release,
  resume,
  retry,
  setConfig,
  setPriority,
  updateTask,
};

export const builtinActions: readonly AnyActionDefinition[] = [
  createTasks,
  updateTask,
  setPriority,
  moveToTop,
  hold,
  release,
  retry,
  pause,
  resume,
  setConfig,
  importTasks,
  exportTasks,
];
