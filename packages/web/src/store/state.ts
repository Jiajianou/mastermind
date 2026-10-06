import type {
  ApiSummary,
  BusEvent,
  ChatMessage,
  ChatView,
  Check,
  Config,
  InstanceInfo,
  IsoTimestamp,
  Proposal,
  Rebase,
  RuntimeFlags,
  Session,
  SessionEvent,
  Task,
  TaskChanges,
} from "@mastermind/core/contracts";

export type Connection = "connecting" | "live" | "reconnecting" | "stopped" | "unauthorized";

export interface SchedulerState {
  paused: boolean;
  authRequired: boolean;
  resumeAt: IsoTimestamp | null;
}

export interface TerminalState {
  taskId: string;
  output: string;
}

export interface ChatState {
  model: string | null;
  replying: boolean;
  messages: readonly ChatMessage[];
  drafts: Readonly<Record<string, string>>;
}

export interface Workspace {
  revision: number;
  files: Readonly<Record<string, number>>;
  anyFile: number;
}

export type ChangesView =
  { kind: "loaded"; changes: TaskChanges } | { kind: "failed"; message: string };

export interface LiveState {
  connection: Connection;
  instance: InstanceInfo | null;
  config: Config | null;
  scheduler: SchedulerState;
  tasks: Readonly<Record<string, Task>>;
  sessions: Readonly<Record<number, Session>>;
  sessionEvents: Readonly<Record<number, readonly SessionEvent[]>>;
  historyLoaded: Readonly<Record<number, true>>;
  editing: Readonly<Record<number, string>>;
  workspaces: Readonly<Record<string, Workspace>>;
  changes: Readonly<Record<string, ChangesView>>;
  checks: Readonly<Record<string, Readonly<Record<number, Check>>>>;
  rebases: Readonly<Record<string, Rebase>>;
  terminals: Readonly<Record<string, TerminalState>>;
  proposals: Readonly<Record<number, Proposal>>;
  chat: ChatState;
}

export interface Snapshot {
  instance: InstanceInfo;
  summary: ApiSummary;
  tasks: readonly Task[];
  sessions: readonly Session[];
  chat: ChatView;
  config: Config;
}

export type StoreAction =
  | BusEvent
  | { type: "snapshot.loaded"; snapshot: Snapshot }
  | { type: "session.history.loaded"; sessionId: number; events: readonly SessionEvent[] }
  | { type: "changes.loaded"; taskId: string; view: ChangesView }
  | { type: "connection.changed"; connection: Connection }
  | { type: "flags.changed"; flags: RuntimeFlags };

export const initialState: LiveState = {
  connection: "connecting",
  instance: null,
  config: null,
  scheduler: { paused: false, authRequired: false, resumeAt: null },
  tasks: {},
  sessions: {},
  sessionEvents: {},
  historyLoaded: {},
  editing: {},
  workspaces: {},
  changes: {},
  checks: {},
  rebases: {},
  terminals: {},
  proposals: {},
  chat: { model: null, replying: false, messages: [], drafts: {} },
};
