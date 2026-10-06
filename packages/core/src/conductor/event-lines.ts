import { postChatMessage } from "../chat.js";
import type { BusEvent, EventLineMeta, TaskStatus } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { EventBus } from "../events.js";
import { hourMinute } from "./format.js";

export interface EventLineOptions {
  db: Db;
  bus: EventBus;
  mainBranch: () => string;
}

interface EventLine {
  content: string;
  meta: EventLineMeta;
}

interface WatchedState {
  taskStatuses: Map<string, TaskStatus>;
  authRequired: boolean;
  resumeAt: string | null;
}

function taskLine(taskId: string, status: TaskStatus, mainBranch: string): EventLine | null {
  switch (status) {
    case "review":
      return { content: `${taskId} is ready for review`, meta: { event: "review", taskId } };
    case "blocked":
      return { content: `${taskId} is blocked`, meta: { event: "blocked", taskId } };
    case "done":
      return {
        content: `${taskId} was rebased onto ${mainBranch}`,
        meta: { event: "rebased", taskId },
      };
    default:
      return null;
  }
}

function lineFor(state: WatchedState, event: BusEvent, mainBranch: () => string): EventLine | null {
  switch (event.type) {
    case "task.updated": {
      const previous = state.taskStatuses.get(event.taskId);
      state.taskStatuses.set(event.taskId, event.task.status);
      return previous === event.task.status
        ? null
        : taskLine(event.taskId, event.task.status, mainBranch());
    }
    case "auth.updated": {
      const signedOut = event.authRequired && !state.authRequired;
      state.authRequired = event.authRequired;
      return signedOut
        ? {
            content: "Sign-in needed: finish it in the terminal running mastermind",
            meta: { event: "sign_in" },
          }
        : null;
    }
    case "checkout.updated":
      return event.onMain
        ? {
            content: `You're on ${event.branch}, so rebasing onto ${event.branch} is paused. Switch to another branch, for example with git switch -c dev, and it carries on.`,
            meta: { event: "owner_on_main", branch: event.branch },
          }
        : null;
    case "scheduler.updated": {
      const { resumeAt } = event;
      const limited = resumeAt !== null && resumeAt !== state.resumeAt;
      state.resumeAt = resumeAt;
      return limited
        ? {
            content: `Usage limit reached; work resumes at ${hourMinute(new Date(resumeAt))}`,
            meta: { event: "usage_limit", resumeAt },
          }
        : null;
    }
    default:
      return null;
  }
}

export function postEventLines({ db, bus, mainBranch }: EventLineOptions): () => void {
  const flags = db.flags.get();
  const state: WatchedState = {
    taskStatuses: new Map(db.tasks.list().map((task) => [task.id, task.status])),
    authRequired: flags.authRequired,
    resumeAt: flags.backoffResumeAt,
  };
  return bus.subscribe((event) => {
    const line = lineFor(state, event, mainBranch);
    if (line !== null) postChatMessage({ db, bus }, { kind: "system", ...line });
  });
}
