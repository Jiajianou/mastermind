import type { ChatMessage, Session, SessionEvent } from "@mastermind/core/contracts";
import type { ChatState, LiveState, SchedulerState, Snapshot, StoreAction } from "./state.js";

export const terminalOutputLimit = 200_000;

function withSession(state: LiveState, session: Session): LiveState {
  return { ...state, sessions: { ...state.sessions, [session.id]: session } };
}

function appendEvent(state: LiveState, event: SessionEvent): LiveState {
  const events = state.sessionEvents[event.sessionId] ?? [];
  if (events.some((known) => known.id === event.id)) return state;
  const last = events.at(-1);
  const next =
    last === undefined || last.id < event.id
      ? [...events, event]
      : [...events, event].sort((a, b) => a.id - b.id);
  return { ...state, sessionEvents: { ...state.sessionEvents, [event.sessionId]: next } };
}

type Touched = { path: string } | "any-file";

function touchWorkspace(state: LiveState, taskId: string, touched?: Touched): LiveState {
  const known = state.workspaces[taskId] ?? { revision: 0, files: {}, anyFile: 0 };
  const revision = known.revision + 1;
  const workspace =
    touched === undefined
      ? { ...known, revision }
      : touched === "any-file"
        ? { ...known, revision, anyFile: revision }
        : { ...known, revision, files: { ...known.files, [touched.path]: revision } };
  return { ...state, workspaces: { ...state.workspaces, [taskId]: workspace } };
}

function withEdit(state: LiveState, sessionId: number, path: string): LiveState {
  if (state.editing[sessionId] === path) return state;
  return { ...state, editing: { ...state.editing, [sessionId]: path } };
}

function withHistory(
  state: LiveState,
  sessionId: number,
  history: readonly SessionEvent[],
): LiveState {
  const stored = state.sessionEvents[sessionId] ?? [];
  const known = new Set(stored.map((event) => event.id));
  const missing = history.filter((event) => !known.has(event.id));
  const historyLoaded: LiveState["historyLoaded"] = { ...state.historyLoaded, [sessionId]: true };
  if (missing.length === 0) return { ...state, historyLoaded };
  const events = [...stored, ...missing].sort((a, b) => a.id - b.id);
  return {
    ...state,
    historyLoaded,
    sessionEvents: { ...state.sessionEvents, [sessionId]: events },
  };
}

function upsertMessage(
  messages: readonly ChatMessage[],
  message: ChatMessage,
): readonly ChatMessage[] {
  const index = messages.findIndex((known) => known.id === message.id);
  if (index !== -1) return messages.with(index, message);
  const last = messages.at(-1);
  if (last === undefined || last.id < message.id) return [...messages, message];
  return [...messages, message].sort((a, b) => a.id - b.id);
}

function withoutDraft(drafts: ChatState["drafts"], turnId: string | null): ChatState["drafts"] {
  if (turnId === null || !(turnId in drafts)) return drafts;
  return Object.fromEntries(Object.entries(drafts).filter(([id]) => id !== turnId));
}

function hasReply(chat: ChatState, turnId: string): boolean {
  return chat.messages.some((message) => message.kind === "conductor" && message.turnId === turnId);
}

function withChat(state: LiveState, change: Partial<ChatState>): LiveState {
  return { ...state, chat: { ...state.chat, ...change } };
}

function withScheduler(state: LiveState, change: Partial<SchedulerState>): LiveState {
  return { ...state, scheduler: { ...state.scheduler, ...change } };
}

function keepUnchanged<Entity>(stored: Entity | undefined, fresh: Entity): Entity {
  return stored !== undefined && JSON.stringify(stored) === JSON.stringify(fresh) ? stored : fresh;
}

function applySnapshot(
  state: LiveState,
  { instance, summary, tasks, sessions, chat, config }: Snapshot,
): LiveState {
  return {
    ...state,
    instance,
    config,
    scheduler: {
      paused: summary.paused,
      authRequired: summary.authRequired,
      resumeAt: summary.resumeAt,
    },
    tasks: Object.fromEntries(
      tasks.map((task) => [task.id, keepUnchanged(state.tasks[task.id], task)]),
    ),
    sessions: Object.fromEntries(
      [...sessions, ...summary.activeSessions].map((session) => [
        session.id,
        keepUnchanged(state.sessions[session.id], session),
      ]),
    ),
    historyLoaded: {},
    chat: { model: chat.model, replying: chat.replying, messages: chat.messages, drafts: {} },
  };
}

export function reduce(state: LiveState, action: StoreAction): LiveState {
  switch (action.type) {
    case "snapshot.loaded":
      return applySnapshot(state, action.snapshot);
    case "session.history.loaded":
      return withHistory(state, action.sessionId, action.events);
    case "connection.changed":
      return state.connection === action.connection
        ? state
        : { ...state, connection: action.connection };
    case "flags.changed":
      return withScheduler(state, {
        paused: action.flags.paused,
        authRequired: action.flags.authRequired,
        resumeAt: action.flags.backoffResumeAt,
      });
    case "task.updated": {
      const known = state.tasks[action.taskId];
      if (known !== undefined && known.updatedAt > action.task.updatedAt) return state;
      return { ...state, tasks: { ...state.tasks, [action.taskId]: action.task } };
    }
    case "session.started":
      return action.sessionId in state.sessions ? state : withSession(state, action.session);
    case "session.ended": {
      const ended = withSession(state, action.session);
      return action.taskId === null ? ended : touchWorkspace(ended, action.taskId);
    }
    case "session.event": {
      const appended = appendEvent(state, action.event);
      if (action.path !== undefined) return withEdit(appended, action.sessionId, action.path);
      if (action.event.type === "commit" && action.taskId !== null)
        return touchWorkspace(appended, action.taskId);
      return appended;
    }
    case "file.changed":
      return touchWorkspace(withEdit(state, action.sessionId, action.path), action.taskId, {
        path: action.path,
      });
    case "workspace.changed":
      return touchWorkspace(state, action.taskId, "any-file");
    case "changes.loaded":
      return { ...state, changes: { ...state.changes, [action.taskId]: action.view } };
    case "check.updated": {
      const checks = { ...state.checks[action.taskId], [action.check.id]: action.check };
      return { ...state, checks: { ...state.checks, [action.taskId]: checks } };
    }
    case "rebase.updated":
      return { ...state, rebases: { ...state.rebases, [action.taskId]: action.rebase } };
    case "main.moved":
    case "checkout.updated":
      return state;
    case "terminal.output": {
      const output = `${state.terminals[action.terminalId]?.output ?? ""}${action.data}`;
      const terminal = { taskId: action.taskId, output: output.slice(-terminalOutputLimit) };
      return { ...state, terminals: { ...state.terminals, [action.terminalId]: terminal } };
    }
    case "chat.message": {
      const { message } = action;
      return withChat(state, {
        messages: upsertMessage(state.chat.messages, message),
        drafts:
          message.kind === "conductor"
            ? withoutDraft(state.chat.drafts, message.turnId)
            : state.chat.drafts,
      });
    }
    case "chat.delta": {
      if (hasReply(state.chat, action.turnId)) return state;
      const draft = `${state.chat.drafts[action.turnId] ?? ""}${action.text}`;
      return withChat(state, { drafts: { ...state.chat.drafts, [action.turnId]: draft } });
    }
    case "chat.turn":
      return withChat(state, {
        replying: action.replying,
        drafts: action.replying
          ? state.chat.drafts
          : withoutDraft(state.chat.drafts, action.turnId),
      });
    case "proposal.updated":
      return {
        ...state,
        proposals: { ...state.proposals, [action.proposal.id]: action.proposal },
      };
    case "auth.updated":
      return withScheduler(state, { authRequired: action.authRequired });
    case "scheduler.updated":
      return withScheduler(state, { paused: action.paused, resumeAt: action.resumeAt });
    case "config.updated":
      return {
        ...state,
        config: action.config,
        chat: { ...state.chat, model: action.config.models.conductor },
      };
    case "service.stopping":
      return { ...state, connection: "stopped" };
  }
}
