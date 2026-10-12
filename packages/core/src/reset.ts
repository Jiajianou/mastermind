import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ActionError, defineAction } from "./actions/index.js";
import type { ContractedActions } from "./actions/index.js";
import { resetProjectInputSchema } from "./contracts/index.js";
import type { Db } from "./db/index.js";
import { deleteClone } from "./git/index.js";
import type { Git } from "./git/index.js";
import { ownerCopyName } from "./rebase/index.js";

export interface ProjectWipe {
  db: Db;
  git: Git;
  repoRoot: string;
  worktreeDir: string;
  logsDir: string;
}

const mastermindRefs = ["refs/mastermind/", "refs/mastermind-branches/"];

async function deleteMastermindRefs(git: Git, repoRoot: string): Promise<void> {
  const listed = await git.run(repoRoot, [
    "for-each-ref",
    "--format=%(refname)",
    ...mastermindRefs,
  ]);
  for (const ref of listed.split("\n").filter((line) => line !== ""))
    await git.run(repoRoot, ["update-ref", "-d", ref]);
}

// Only clones mastermind recorded are deleted, never the whole worktree folder, which the owner may have pointed
// somewhere shared.
export async function wipeProject({
  db,
  git,
  repoRoot,
  worktreeDir,
  logsDir,
}: ProjectWipe): Promise<void> {
  const clones = db.tasks.list().flatMap((task) => (task.worktree === null ? [] : [task.worktree]));
  for (const clone of [...clones, join(worktreeDir, ownerCopyName)])
    await deleteClone(clone, worktreeDir);
  await deleteMastermindRefs(git, repoRoot);
  db.wipe();
  await rm(logsDir, { recursive: true, force: true });
}

export function resetProjectAction({
  project,
  requestReset,
}: {
  project: string;
  requestReset: () => void;
}) {
  return defineAction({
    name: "resetProject",
    description:
      "Stop every session and delete all tasks, sessions, chat and logs of this project, with the task clones. Settings and the repo's own branches stay. Confirm by passing the project's name.",
    input: resetProjectInputSchema,
    emits: [],
    handler: (input) => {
      if (input.project !== project)
        throw ActionError.fromMessage(
          "invalid_input",
          `type the project's name, ${project}, to confirm`,
        );
      requestReset();
      return { resetting: true as const };
    },
  }) satisfies ContractedActions<"resetProject">["resetProject"];
}
