import { ActionError } from "./actions/index.js";
import type { ChatState } from "./chat.js";
import type {
  ApiSummary,
  ChatView,
  Config,
  InstanceInfo,
  Session,
  SessionEvent,
  SessionsQuery,
  Summary,
  Task,
  TaskView,
} from "./contracts/index.js";
import type { Db } from "./db/index.js";
import type { Git } from "./git/index.js";
import { createTaskFiles } from "./task-files.js";
import type { TaskFiles } from "./task-files.js";

export interface ReadSources {
  db: Db;
  git: Git;
  instance: InstanceInfo;
  summary: () => Summary;
  chat: Pick<ChatState, "status">;
  config: () => Config;
}

export interface ReadModels extends TaskFiles {
  instance(): InstanceInfo;
  summary(): ApiSummary;
  tasks(): TaskView[];
  task(taskId: string): TaskView;
  sessions(query: SessionsQuery): Session[];
  sessionEvents(sessionId: number, afterId?: number): SessionEvent[];
  chat(afterId?: number): ChatView;
  config(): Config;
}

function taskViews(tasks: readonly Task[]): TaskView[] {
  const unblocks = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.deps) unblocks.set(dep, [...(unblocks.get(dep) ?? []), task.id]);
  }
  return tasks.map((task) => ({ ...task, unblocks: unblocks.get(task.id) ?? [] }));
}

export function createReadModels({
  db,
  git,
  instance,
  summary,
  chat,
  config,
}: ReadSources): ReadModels {
  return {
    ...createTaskFiles({ db, git }),

    instance: () => instance,

    summary() {
      const rebaseQueue = db.tasks
        .list()
        .filter((task) => task.status === "rebasing")
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        .map((task) => task.id);
      return { ...summary(), activeSessions: db.sessions.listRunning(), rebaseQueue };
    },

    tasks: () => taskViews(db.tasks.list()),

    task(taskId) {
      const task = taskViews(db.tasks.list()).find((view) => view.id === taskId);
      if (task === undefined) throw ActionError.fromMessage("not_found", `no task "${taskId}"`);
      return task;
    },

    sessions({ taskId, since }) {
      const startedSince = since === undefined ? undefined : new Date(since).toISOString();
      return db.sessions.list({ taskId, startedSince });
    },

    sessionEvents(sessionId, afterId) {
      if (db.sessions.get(sessionId) === null)
        throw ActionError.fromMessage("not_found", `no session ${String(sessionId)}`);
      return db.events.listForSession(sessionId, { afterId });
    },

    chat: (afterId) => ({ ...chat.status(), messages: db.chat.list(afterId) }),

    config,
  };
}
