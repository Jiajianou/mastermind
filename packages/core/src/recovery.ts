import { existsSync } from "node:fs";
import { assertTransition } from "./actions/transitions.js";
import { isEditingRole } from "./contracts/index.js";
import type { Session, Task } from "./contracts/index.js";
import type { Db, KilledCounts } from "./db/index.js";
import { commitLeftovers } from "./git/index.js";
import type { Git } from "./git/index.js";
import { killTreesSync, ProcessKillError, readLiveProcess } from "./procs.js";
import { canResumeConversation } from "./sessions/conversation.js";

export const interruptedMessage = "WIP: interrupted";

export interface RecoveryOptions {
  db: Db;
  git: Git;
}

export type RecoveryFailure =
  | { kind: "reap"; sessionId: number; error: unknown }
  | { kind: "save"; taskId: string; error: unknown };

export interface RecoveryReport {
  reaped: number[];
  saved: { taskId: string; commit: string }[];
  requeued: { taskId: string; resumeSession: string | null }[];
  killed: KilledCounts;
  failures: RecoveryFailure[];
}

export async function recoverPreviousRun({ db, git }: RecoveryOptions): Promise<RecoveryReport> {
  const failures: RecoveryFailure[] = [];
  const reaped = db.sessions.listRunning().filter((session) => reapLeftover(session, failures));
  const interrupted = db.tasks.list().filter((task) => task.status === "running");
  const saved: RecoveryReport["saved"] = [];
  for (const task of interrupted) {
    const commit = await saveWork(git, task, failures);
    if (commit !== null) saved.push({ taskId: task.id, commit });
  }
  const { killed, requeued } = db.transaction(() => ({
    killed: db.killRunning(),
    requeued: interrupted.map((task) => requeue(db, task)),
  }));
  return { reaped: reaped.map((session) => session.id), saved, requeued, killed, failures };
}

// A pid alone may have been reused by an unrelated process since the hard kill, so a group is only killed when
// the live process still carries the session's claude id on its command line.
function reapLeftover(session: Session, failures: RecoveryFailure[]): boolean {
  const { pid, claudeSessionId } = session;
  if (pid === null || claudeSessionId === null) return false;
  try {
    const live = readLiveProcess(pid);
    if (live?.command.includes(claudeSessionId) !== true) return false;
    const killFailures = killTreesSync([live]);
    if (killFailures.length > 0)
      failures.push({
        kind: "reap",
        sessionId: session.id,
        error: new ProcessKillError(killFailures),
      });
    return true;
  } catch (error) {
    failures.push({ kind: "reap", sessionId: session.id, error });
    return false;
  }
}

async function saveWork(git: Git, task: Task, failures: RecoveryFailure[]): Promise<string | null> {
  if (task.worktree === null || !existsSync(task.worktree)) return null;
  try {
    return await commitLeftovers(git, task.worktree, interruptedMessage);
  } catch (error) {
    failures.push({ kind: "save", taskId: task.id, error });
    return null;
  }
}

function requeue(db: Db, task: Task): RecoveryReport["requeued"][number] {
  assertTransition(task.id, task.status, "pending");
  const resumeSession = resumableSession(db, task.id);
  db.tasks.update(task.id, { status: "pending", resumeSession });
  return { taskId: task.id, resumeSession };
}

function resumableSession(db: Db, taskId: string): string | null {
  const latest = db.sessions.listForTask(taskId).findLast(isEditingRole);
  const claudeSessionId = latest?.claudeSessionId ?? null;
  if (claudeSessionId === null) return null;
  return canResumeConversation(db, taskId, claudeSessionId) ? claudeSessionId : null;
}
