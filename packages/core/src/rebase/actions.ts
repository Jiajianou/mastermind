import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { ActionError, defineAction, requireTask } from "../actions/index.js";
import type { ContractedActions } from "../actions/index.js";
import { fileStamp } from "../checks/runner.js";
import type { Clock } from "../clock.js";
import type { ResolvedConfig } from "../config/index.js";
import { taskRefInputSchema } from "../contracts/index.js";
import type { Task, TaskStatus } from "../contracts/index.js";
import { deleteClone, pathInside, taskRef } from "../git/index.js";
import type { Git } from "../git/index.js";
import { deleteRef } from "./main-ref.js";

export interface DiscardSources {
  git: Git;
  repoRoot: string;
  config: () => ResolvedConfig;
  clock: Clock;
}

const discardable: readonly TaskStatus[] = ["review", "blocked"];

export const approve = defineAction({
  name: "approve",
  description:
    "Approve a task that is waiting in review and rebase it onto main: it joins the rebase queue, which squashes it into one commit and fast-forwards main. Returns the task.",
  input: taskRefInputSchema,
  emits: ["task.updated"],
  handler: ({ taskId }, { db, emit }) => {
    const task = requireTask(db, taskId);
    if (task.status !== "review")
      throw ActionError.fromMessage(
        "conflict",
        `only a task in review can be approved; ${taskId} is ${task.status}`,
      );
    const rebasing = db.tasks.update(taskId, { status: "rebasing" });
    emit({ type: "task.updated", taskId, task: rebasing });
    return rebasing;
  },
}) satisfies ContractedActions<"approve">["approve"];

// The clone is renamed aside in the same tick as the task leaves review, so nothing (a checks re-run after main
// moved, a new start of the task) can pick it up while it is being deleted.
function moveCloneAside(task: Task, worktreeDir: string, now: Date): string | null {
  const { worktree } = task;
  if (worktree === null || !existsSync(worktree)) return null;
  if (pathInside(resolve(worktreeDir), resolve(worktree)) === null)
    throw ActionError.fromMessage(
      "conflict",
      `the clone of ${task.id} at ${worktree} is outside ${worktreeDir}; delete it by hand`,
    );
  const aside = `${worktree}.discarded-${fileStamp(now)}`;
  renameSync(worktree, aside);
  return aside;
}

export function discardAction({ git, repoRoot, config, clock }: DiscardSources) {
  return defineAction({
    name: "discard",
    description:
      "Discard a task's work: delete its branch and clone, and return it to pending with its attempts reset, so it starts again from current main. Allowed for a task in review or blocked. Returns the task.",
    input: taskRefInputSchema,
    emits: ["task.updated"],
    handler: async ({ taskId }, { db, emit }) => {
      const task = requireTask(db, taskId);
      if (!discardable.includes(task.status))
        throw ActionError.fromMessage(
          "conflict",
          `only a task in review or blocked can be discarded; ${taskId} is ${task.status}`,
        );
      const { worktreeDir } = config();
      const aside = moveCloneAside(task, worktreeDir, clock.now());
      const pending = db.tasks.update(taskId, {
        status: "pending",
        attempts: 0,
        worktree: null,
        branch: null,
        baseCommit: null,
        resumeSession: null,
      });
      emit({ type: "task.updated", taskId, task: pending });
      if (aside !== null) await deleteClone(aside, worktreeDir);
      await deleteRef(git, repoRoot, taskRef(taskId));
      return pending;
    },
  }) satisfies ContractedActions<"discard">["discard"];
}
