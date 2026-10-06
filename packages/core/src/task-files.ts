import { existsSync } from "node:fs";
import { ActionError } from "./actions/index.js";
import { parseChangesSince } from "./contracts/index.js";
import type {
  ChangesInput,
  FileContent,
  FileQuery,
  TaskChanges,
  TaskTree,
} from "./contracts/index.js";
import type { Db } from "./db/index.js";
import {
  listChanges,
  listTree,
  NotAFileError,
  readCommittedFile,
  readWorktreeFile,
  UnsafePathError,
} from "./git/index.js";
import type { Git } from "./git/index.js";

export interface TaskFiles {
  changes(input: ChangesInput): Promise<TaskChanges>;
  file(taskId: string, query: FileQuery): Promise<FileContent>;
  tree(taskId: string): Promise<TaskTree>;
}

interface Workspace {
  worktree: string;
  baseCommit: string;
}

function workspaceOf(db: Db, taskId: string): Workspace {
  const task = db.tasks.get(taskId);
  if (task === null) throw ActionError.fromMessage("not_found", `no task "${taskId}"`);
  const { worktree, baseCommit } = task;
  if (worktree === null || baseCommit === null)
    throw ActionError.fromMessage("conflict", `task "${taskId}" has no workspace yet`);
  if (!existsSync(worktree))
    throw ActionError.fromMessage("conflict", `the workspace of task "${taskId}" was removed`);
  return { worktree, baseCommit };
}

// Round N ends where round N+1 was requested: that is the state the owner reviewed, after the checks had rebased it.
// A round with no later one yet ends at its latest session's end commit.
function roundEndCommit(db: Db, taskId: string, round: number): string {
  const reviewed = db.rounds.get(taskId, round + 1)?.startCommit ?? null;
  if (reviewed !== null) return reviewed;
  const endCommit = db.sessions
    .listForTask(taskId)
    .flatMap((session) =>
      session.round === round && session.endCommit !== null ? [session.endCommit] : [],
    )
    .at(-1);
  if (endCommit === undefined)
    throw ActionError.fromMessage(
      "not_found",
      `round ${String(round)} of task "${taskId}" has no finished session`,
    );
  return endCommit;
}

function fromCommit(db: Db, taskId: string, since: string, workspace: Workspace): string {
  const parsed = parseChangesSince(since);
  return parsed.kind === "base" ? workspace.baseCommit : roundEndCommit(db, taskId, parsed.round);
}

async function asInputErrors<Result>(work: () => Promise<Result>): Promise<Result> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof UnsafePathError || error instanceof NotAFileError)
      throw new ActionError("invalid_input", [{ path: "path", message: error.message }]);
    throw error;
  }
}

export function createTaskFiles({ db, git }: { db: Db; git: Git }): TaskFiles {
  return {
    async changes({ taskId, since }) {
      const workspace = workspaceOf(db, taskId);
      const commit = fromCommit(db, taskId, since, workspace);
      const files = await listChanges(git, workspace.worktree, commit);
      return { taskId, since, fromCommit: commit, files };
    },

    file(taskId, { path, side, since }) {
      const workspace = workspaceOf(db, taskId);
      return asInputErrors(() =>
        side === "current"
          ? readWorktreeFile(workspace.worktree, path)
          : readCommittedFile(
              git,
              workspace.worktree,
              fromCommit(db, taskId, since, workspace),
              path,
            ),
      );
    },

    async tree(taskId) {
      const { worktree } = workspaceOf(db, taskId);
      return { taskId, files: await listTree(git, worktree) };
    },
  };
}
