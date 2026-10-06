import type { ActionName } from "../contracts/index.js";
import type { AnyActionDefinition, ContractedActions } from "./registry.js";
import { confirmSetup, pause, resume, setConfig } from "./runtime.js";
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
  ContractedActions,
} from "./registry.js";
export { setBackoff } from "./runtime.js";
export type { SchedulerScope } from "./runtime.js";
export { assertValidBatch } from "./tasks.js";
export { readTasksFile, writeTasksFile } from "./tasks-file.js";
export type { TasksFile } from "./tasks-file.js";
export { assertTransition, canTransition } from "./transitions.js";
export {
  confirmSetup,
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

const builtins = {
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
  confirmSetup,
  importTasks,
  exportTasks,
} satisfies ContractedActions<
  Exclude<
    ActionName,
    | "rerunChecks"
    | "stopSession"
    | "messageSession"
    | "confirmProposal"
    | "rejectProposal"
    | "sendChat"
    | "stopChat"
  >
>;

export const builtinActions: readonly AnyActionDefinition[] = Object.values(builtins);
