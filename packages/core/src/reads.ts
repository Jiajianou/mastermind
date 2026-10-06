import { ActionError } from "./actions/index.js";
import type { ChatState } from "./chat.js";
import { checkLogMaxBytes, readLogTail } from "./checks/log.js";
import { isMissingFileError } from "./config/index.js";
import type {
  ApiSummary,
  ChatView,
  Check,
  CheckLog,
  CheckLogInput,
  Comment,
  Config,
  Finding,
  InstanceInfo,
  OwnerBranch,
  ReviewNotes,
  Round,
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
  ownerBranch: () => Promise<OwnerBranch>;
}

export interface ReadModels extends TaskFiles {
  instance(): InstanceInfo;
  summary(): ApiSummary;
  tasks(): TaskView[];
  task(taskId: string): TaskView;
  sessions(query: SessionsQuery): Session[];
  sessionEvents(sessionId: number, afterId?: number): SessionEvent[];
  checks(taskId: string): Check[];
  comments(taskId: string): Comment[];
  findings(taskId: string): Finding[];
  rounds(taskId: string): Round[];
  reviewNotes(taskId: string): ReviewNotes;
  checkLog(checkId: number): Promise<CheckLog>;
  taskCheckLog(input: CheckLogInput): Promise<CheckLog>;
  chat(afterId?: number): ChatView;
  config(): Config;
  ownerBranch(): Promise<OwnerBranch>;
}

const notFound = (message: string) => ActionError.fromMessage("not_found", message);

async function readCheckLog(check: Check, maxLines?: number): Promise<CheckLog> {
  const id = String(check.id);
  if (check.logPath === null) throw notFound(`check ${id} has no log`);
  try {
    const tail = await readLogTail(check.logPath, { maxBytes: checkLogMaxBytes, maxLines });
    return { check, ...tail };
  } catch (error) {
    if (isMissingFileError(error)) throw notFound(`the log of check ${id} is gone`);
    throw error;
  }
}

function taskViews(tasks: readonly Task[]): TaskView[] {
  const unblocks = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of task.deps) unblocks.set(dep, [...(unblocks.get(dep) ?? []), task.id]);
  }
  return tasks.map((task) => ({ ...task, unblocks: unblocks.get(task.id) ?? [] }));
}

function requireTask(db: Db, taskId: string): Task {
  const task = db.tasks.get(taskId);
  if (task === null) throw notFound(`no task "${taskId}"`);
  return task;
}

export function createReadModels({
  db,
  git,
  instance,
  summary,
  chat,
  config,
  ownerBranch,
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

    checks(taskId) {
      requireTask(db, taskId);
      return db.checks.listForTask(taskId);
    },

    comments(taskId) {
      requireTask(db, taskId);
      return db.comments.listForTask(taskId);
    },

    findings(taskId) {
      requireTask(db, taskId);
      return db.findings.listForTask(taskId);
    },

    rounds(taskId) {
      requireTask(db, taskId);
      return db.rounds.listForTask(taskId);
    },

    reviewNotes(taskId) {
      const { round } = requireTask(db, taskId);
      return {
        taskId,
        round,
        comments: db.comments.listForTask(taskId),
        findings: db.findings.listForTask(taskId),
        rounds: db.rounds.listForTask(taskId),
      };
    },

    checkLog(checkId) {
      const check = db.checks.get(checkId);
      if (check === null) return Promise.reject(notFound(`no check ${String(checkId)}`));
      return readCheckLog(check);
    },

    taskCheckLog({ taskId, checkId, lines }) {
      if (db.tasks.get(taskId) === null) return Promise.reject(notFound(`no task "${taskId}"`));
      const checks = db.checks.listForTask(taskId);
      const check =
        checkId === undefined
          ? (checks.findLast((candidate) => candidate.status === "failed") ?? checks.at(-1))
          : checks.find((candidate) => candidate.id === checkId);
      if (check === undefined)
        return Promise.reject(
          notFound(
            checkId === undefined
              ? `${taskId} has no checks yet`
              : `${taskId} has no check ${String(checkId)}`,
          ),
        );
      return readCheckLog(check, lines);
    },

    chat: (afterId) => ({ ...chat.status(), messages: db.chat.list(afterId) }),

    config,

    ownerBranch,
  };
}
