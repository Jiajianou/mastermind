import type { z } from "zod";
import { parseInput } from "../actions/index.js";
import type { ActionRegistry } from "../actions/index.js";
import type { ConductorChatSink } from "../chat.js";
import {
  configLayerSchema,
  createTasksInputSchema,
  noInputSchema,
  proposePlanInputSchema,
  sessionEventsInputSchema,
  sessionRefInputSchema,
  sessionsQuerySchema,
  setPriorityInputSchema,
  taskRefInputSchema,
  updateTaskInputSchema,
} from "../contracts/index.js";
import type { ActionName, AwaitingConfirmation } from "../contracts/index.js";
import type { GateableTool, GateOutcome, ProposalGate } from "../proposals.js";
import type { ReadModels } from "../reads.js";
import { proposePlan } from "./plan.js";

export interface ToolSources {
  actions: ActionRegistry;
  gate: ProposalGate;
  reads: ReadModels;
  chat: ConductorChatSink;
}

export interface ConductorTool {
  name: string;
  description: string;
  input: z.ZodType;
  call(input: unknown): Promise<unknown>;
}

export interface ActionTool extends GateableTool {
  action: ActionName;
  description: string;
  done(input: unknown): string;
}

interface ReadTool {
  name: string;
  description: string;
  input: z.ZodType;
  read(reads: ReadModels, input: unknown): unknown;
}

function actionTool<Schema extends z.ZodType>(tool: {
  name: string;
  action: ActionName;
  input: Schema;
  description: string;
  describe: (input: z.output<Schema>) => string;
  done: (input: z.output<Schema>) => string;
}): ActionTool {
  const { name, action, description } = tool;
  return {
    name,
    action,
    description,
    describe: (input) => tool.describe(parseInput(tool.input, input)),
    done: (input) => tool.done(parseInput(tool.input, input)),
  };
}

function readTool<Schema extends z.ZodType>(tool: {
  name: string;
  input: Schema;
  description: string;
  read: (reads: ReadModels, input: z.output<Schema>) => unknown;
}): ReadTool {
  const { name, input, description } = tool;
  return {
    name,
    input,
    description,
    read: (reads, raw) => tool.read(reads, parseInput(input, raw)),
  };
}

const fieldList = (input: object): string => Object.keys(input).join(", ");

const count = (amount: number, noun: string): string =>
  `${String(amount)} ${noun}${amount === 1 ? "" : "s"}`;

export const actionTools: readonly ActionTool[] = [
  actionTool({
    name: "create_tasks",
    action: "createTasks",
    input: createTasksInputSchema,
    description:
      "Add tasks to the graph in one batch. Each task needs a unique slug id, a title, a goal written for the worker, an acceptance shell command that exits 0 when the task is done, and touches: the repo paths it will change (tasks with overlapping touches never run at the same time). deps may name tasks in the batch or existing ones. The whole batch is rejected on a duplicate id, an unknown dep or a cycle. A task starts once its deps are done and a worker is free.",
    describe: ({ tasks }) => `Add ${tasks.map((task) => task.id).join(", ")}`,
    done: ({ tasks }) => `Added ${count(tasks.length, "task")}`,
  }),
  actionTool({
    name: "update_task",
    action: "updateTask",
    input: updateTaskInputSchema,
    description:
      "Change a task's title, goal, acceptance, touches, deps or priority; only the fields given change. New deps must exist and must not create a cycle. Work already running is not affected.",
    describe: ({ taskId, ...changes }) => `Change ${fieldList(changes)} of ${taskId}`,
    done: ({ taskId }) => `Updated ${taskId}`,
  }),
  actionTool({
    name: "set_priority",
    action: "setPriority",
    input: setPriorityInputSchema,
    description:
      "Set a task's priority. Among ready tasks, higher numbers start first; the default is 0.",
    describe: ({ taskId, priority }) => `Set the priority of ${taskId} to ${String(priority)}`,
    done: ({ taskId, priority }) => `Set the priority of ${taskId} to ${String(priority)}`,
  }),
  actionTool({
    name: "hold",
    action: "hold",
    input: taskRefInputSchema,
    description:
      "Hold a task so it does not start. Work already running continues; use stop_session to stop it.",
    describe: ({ taskId }) => `Hold ${taskId}`,
    done: ({ taskId }) => `Held ${taskId}`,
  }),
  actionTool({
    name: "release",
    action: "release",
    input: taskRefInputSchema,
    description:
      "Release a held task so it can start again, including one held by stop_session, which then resumes its session.",
    describe: ({ taskId }) => `Release ${taskId}`,
    done: ({ taskId }) => `Released ${taskId}`,
  }),
  actionTool({
    name: "retry",
    action: "retry",
    input: taskRefInputSchema,
    description:
      "Put a blocked task back in the queue with its attempts reset. Fails for a task that is not blocked.",
    describe: ({ taskId }) => `Retry ${taskId}`,
    done: ({ taskId }) => `Retried ${taskId}`,
  }),
  actionTool({
    name: "pause_all",
    action: "pause",
    input: noInputSchema,
    description: "Stop starting new sessions. Sessions already running carry on.",
    describe: () => "Pause all work",
    done: () => "Paused all work",
  }),
  actionTool({
    name: "resume_all",
    action: "resume",
    input: noInputSchema,
    description: "Start sessions again after pause_all.",
    describe: () => "Resume work",
    done: () => "Resumed work",
  }),
  actionTool({
    name: "stop_session",
    action: "stopSession",
    input: sessionRefInputSchema,
    description:
      "Stop a running session (SIGTERM, then SIGKILL after 10 seconds). Its task is held and keeps the session for resuming; release the task to continue.",
    describe: ({ sessionId }) => `Stop session ${String(sessionId)}`,
    done: ({ sessionId }) => `Stopped session ${String(sessionId)}`,
  }),
  actionTool({
    name: "set_config",
    action: "setConfig",
    input: configLayerSchema,
    description:
      "Change project settings in .mastermind/config.yaml. Only the keys given change, and nested objects such as models merge key by key.",
    describe: (change) => `Change ${fieldList(change)} in settings`,
    done: (change) => `Changed ${fieldList(change)} in settings`,
  }),
];

const readTools: readonly ReadTool[] = [
  readTool({
    name: "get_summary",
    input: noInputSchema,
    description:
      "The state at a glance: task counts by status, running sessions, what starts next, blocked tasks, the rebase queue, and whether work is paused, waiting for sign-in or backing off after a usage limit.",
    read: (reads) => reads.summary(),
  }),
  readTool({
    name: "list_tasks",
    input: noInputSchema,
    description:
      "Every task with its status, priority, held flag, attempts, deps and the tasks it unblocks.",
    read: (reads) => reads.tasks(),
  }),
  readTool({
    name: "get_task",
    input: taskRefInputSchema,
    description:
      "One task in full: title, goal, acceptance command, touches, deps, what it unblocks, status, attempts and review round.",
    read: (reads, { taskId }) => reads.task(taskId),
  }),
  readTool({
    name: "list_sessions",
    input: sessionsQuerySchema,
    description:
      "Claude sessions, oldest first, with role, status, model and tokens. Filter by taskId; since (an ISO time) keeps sessions started at or after it plus every running one.",
    read: (reads, query) => reads.sessions(query),
  }),
  readTool({
    name: "get_session_events",
    input: sessionEventsInputSchema,
    description:
      "A session's timeline: reads, edits, commands, commits, notes, steering and the result. Returns the latest `limit` events (default 50) whose id is above `after`; pass the last id you saw as `after` to get only newer ones.",
    read: (reads, { sessionId, after, limit }) =>
      reads.sessionEvents(sessionId, after).slice(-limit),
  }),
];

const gatedNote =
  "Needs the owner's confirmation: the call changes nothing yet and returns awaiting_confirmation with a proposalId. The owner's decision arrives as a system message on a later turn.";

function gateReply(outcome: GateOutcome): unknown {
  if (outcome.kind === "done") return outcome.result;
  const reply: AwaitingConfirmation = {
    status: "awaiting_confirmation",
    proposalId: outcome.proposal.id,
    question: outcome.question,
  };
  return reply;
}

export function conductorTools({ actions, gate, reads, chat }: ToolSources): ConductorTool[] {
  const registered = new Map(actions.list().map((info) => [info.name, info.input]));
  const fromReads = readTools.map((tool): ConductorTool => ({
    name: tool.name,
    description: tool.description,
    input: tool.input,
    call: (input) => Promise.resolve(tool.read(reads, input)),
  }));
  const fromActions = actionTools.flatMap((tool): ConductorTool[] => {
    const input = registered.get(tool.action);
    if (input === undefined) return [];
    const description = gate.isGated(tool.name)
      ? `${tool.description} ${gatedNote}`
      : tool.description;
    return [
      {
        name: tool.name,
        description,
        input,
        call: async (args) => gateReply(await gate.run(tool, args)),
      },
    ];
  });
  const plan: ConductorTool = {
    name: "propose_plan",
    description:
      "Show the owner a plan as a numbered list, one line per task: its id, then the note (or the title). Takes the same task fields as create_tasks plus an optional short note such as 'after the first two', and is checked the same way. Nothing is created: the owner can click Start, which creates the tasks as given, or reply 'go ahead', and then you call create_tasks with the same tasks.",
    input: proposePlanInputSchema,
    call: (input) => {
      const message = proposePlan(chat, parseInput(proposePlanInputSchema, input));
      return Promise.resolve({ status: "shown", messageId: message.id });
    },
  };
  return [...fromReads, ...fromActions, plan];
}
