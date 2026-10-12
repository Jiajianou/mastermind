import type {
  ChatMessage,
  ChatView,
  Check,
  ReviewNotes,
  Session,
  SessionEvent,
  SessionLive,
} from "@mastermind/core/contracts";
import type {
  ChatState,
  LiveActivity,
  LiveState,
  SchedulerState,
  Snapshot,
  StoreAction,
  TerminalState,
} from "./state.js";
import { appendOutput, withStatus, withView } from "./terminals.js";

function withTerminal(state: LiveState, taskId: string, terminal: TerminalState): LiveState {
  if (state.terminals[taskId] === terminal) return state;
  return { ...state, terminals: { ...state.terminals, [taskId]: terminal } };
}

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

function nextActivity(previous: LiveActivity | undefined, live: SessionLive): LiveActivity {
  switch (live.kind) {
    case "thinking":
      return live;
    case "tool":
      return live;
    case "text":
      return {
        kind: "text",
        text: `${previous?.kind === "text" ? previous.text : ""}${live.delta}`,
      };
  }
}

// A stored event ends whatever was streaming: its finished line is now in the timeline.
function withoutActivity(state: LiveState, sessionId: number): LiveState {
  if (!(sessionId in state.sessionLive)) return state;
  const sessionLive = Object.fromEntries(
    Object.entries(state.sessionLive).filter(([id]) => Number(id) !== sessionId),
  );
  return { ...state, sessionLive };
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

function withChat(state: LiveState, change: Partial<ChatState>): LiveState {
  return { ...state, chat: { ...state.chat, ...change } };
}

function withScheduler(state: LiveState, change: Partial<SchedulerState>): LiveState {
  return { ...state, scheduler: { ...state.scheduler, ...change } };
}

// A load can answer with a check still running after its check.updated already said it finished, and a finished
// check never runs again, so the finished copy wins.
function withLoadedChecks(state: LiveState, taskId: string, loaded: readonly Check[]): LiveState {
  const stored = state.checks[taskId] ?? {};
  const checks = Object.fromEntries(
    loaded.map((check) => {
      const known = stored[check.id];
      const keep = known !== undefined && known.status !== "running" && check.status === "running";
      return [check.id, keep ? known : keepUnchanged(known, check)];
    }),
  );
  return { ...state, checks: { ...state.checks, [taskId]: { ...stored, ...checks } } };
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
    sessionLive: {},
    chat: chatFromView(chat),
  };
}

function chatFromView(view: ChatView): ChatState {
  return {
    model: view.model,
    replying: view.replying,
    conversationId: view.conversationId,
    conversations: view.conversations,
    messages: view.messages,
    drafts: {},
    activity: null,
  };
}

function touchConversation(
  conversations: ChatState["conversations"],
  id: number,
  at: string,
): ChatState["conversations"] {
  return conversations.map((conversation) =>
    conversation.id === id && conversation.lastActivityAt < at
      ? { ...conversation, lastActivityAt: at }
      : conversation,
  );
}

function upsertById<Item extends { id: number }>(items: readonly Item[], item: Item): Item[] {
  return [...items.filter((known) => known.id !== item.id), item].sort((a, b) => a.id - b.id);
}

// Notes are only kept for tasks whose notes were read; a task opened later reads them in full.
function withNotes(
  state: LiveState,
  taskId: string,
  change: (notes: ReviewNotes) => Partial<ReviewNotes>,
): LiveState {
  const notes = state.notes[taskId];
  if (notes === undefined) return state;
  return { ...state, notes: { ...state.notes, [taskId]: { ...notes, ...change(notes) } } };
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
    case "session.live":
      return {
        ...state,
        sessionLive: {
          ...state.sessionLive,
          [action.sessionId]: nextActivity(state.sessionLive[action.sessionId], action.live),
        },
      };
    case "session.ended": {
      const ended = withSession(withoutActivity(state, action.sessionId), action.session);
      return action.taskId === null ? ended : touchWorkspace(ended, action.taskId);
    }
    case "session.event": {
      const appended = appendEvent(withoutActivity(state, action.sessionId), action.event);
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
      return { ...state, changes: { ...state.changes, [action.key]: action.view } };
    case "notes.loaded":
      return { ...state, notes: { ...state.notes, [action.notes.taskId]: action.notes } };
    case "comment.updated":
      return withNotes(state, action.taskId, ({ comments }) => ({
        comments: upsertById(comments, action.comment),
      }));
    case "comment.deleted":
      return withNotes(state, action.taskId, ({ comments }) => ({
        comments: comments.filter((comment) => comment.id !== action.commentId),
      }));
    case "finding.updated":
      return withNotes(state, action.taskId, ({ findings }) => ({
        findings: upsertById(findings, action.finding),
      }));
    case "checks.loaded":
      return withLoadedChecks(state, action.taskId, action.checks);
    case "check.updated": {
      const checks = { ...state.checks[action.taskId], [action.check.id]: action.check };
      return { ...state, checks: { ...state.checks, [action.taskId]: checks } };
    }
    case "rebase.updated":
      return { ...state, rebases: { ...state.rebases, [action.taskId]: action.rebase } };
    case "branch.updated":
      return { ...state, ownerBranch: action.branch };
    case "main.moved":
    case "checkout.updated":
      return state;
    case "terminal.output":
      return withTerminal(
        state,
        action.taskId,
        appendOutput(state.terminals[action.taskId], action),
      );
    case "terminal.updated":
      return withTerminal(
        state,
        action.taskId,
        withStatus(state.terminals[action.taskId], action.terminal),
      );
    case "terminal.loaded":
      return withTerminal(
        state,
        action.taskId,
        withView(state.terminals[action.taskId], action.view),
      );
    case "chat.message": {
      const { message } = action;
      if (message.conversationId !== state.chat.conversationId) return state;
      return withChat(state, {
        conversations: touchConversation(
          state.chat.conversations,
          message.conversationId,
          message.ts,
        ),
        messages: upsertMessage(state.chat.messages, message),
        drafts:
          message.kind === "conductor"
            ? withoutDraft(state.chat.drafts, message.turnId)
            : state.chat.drafts,
      });
    }
    // The stream announces an opened conversation and the request that opened it returns it too; whichever comes
    // second is older than what the stream has applied since, so it is dropped.
    case "chat.opened":
      return action.view.conversationId === state.chat.conversationId
        ? state
        : { ...state, chat: chatFromView(action.view) };
    case "conversation.updated": {
      const { conversation } = action;
      const known = state.chat.conversations.some(({ id }) => id === conversation.id);
      return withChat(state, {
        conversations: known
          ? state.chat.conversations.map((existing) =>
              existing.id === conversation.id ? conversation : existing,
            )
          : [conversation, ...state.chat.conversations],
      });
    }
    case "conversation.deleted":
      return withChat(state, {
        conversations: state.chat.conversations.filter(({ id }) => id !== action.conversationId),
      });
    case "chat.delta": {
      const draft = `${state.chat.drafts[action.turnId] ?? ""}${action.text}`;
      return withChat(state, {
        drafts: { ...state.chat.drafts, [action.turnId]: draft },
        activity: null,
      });
    }
    case "chat.activity":
      return withChat(state, { activity: action.text });
    case "chat.turn":
      return withChat(state, {
        replying: action.replying,
        activity: null,
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
    case "notification":
      return { ...state, notification: action.notification };
    case "service.stopping":
      return { ...state, connection: "stopped" };
  }
}
