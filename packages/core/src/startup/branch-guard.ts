import { GitError } from "../git/index.js";
import type { Git } from "../git/index.js";
import { hasUncommittedChanges } from "../rebase/owner-checkout.js";
import { StartupError } from "./errors.js";
import { currentBranch, localBranches } from "./repo.js";
import type { Choice, StartupPrompts } from "./prompts.js";

export const defaultWorkBranch = "dev";

export interface BranchGuardOptions {
  git: Git;
  repoRoot: string;
  mainBranch: string;
  prompts: StartupPrompts;
}

type GuardChoice = "new" | "existing" | "stay" | "quit";

function unusedBranchName(taken: readonly string[]): string {
  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? defaultWorkBranch : `${defaultWorkBranch}-${String(suffix)}`;
    if (!taken.includes(name)) return name;
  }
}

function quit(mainBranch: string): StartupError {
  return new StartupError("quit", `Quit: mastermind didn't start, and ${mainBranch} is unchanged.`);
}

async function pickExistingBranch(
  others: readonly string[],
  { mainBranch, prompts }: BranchGuardOptions,
): Promise<string> {
  const quitValue = "";
  const choices: Choice<string>[] = [
    ...others.map((branch) => ({ value: branch, label: branch })),
    { value: quitValue, label: "Quit" },
  ];
  const branch = await prompts.choose("Switch to which branch?", choices, quitValue);
  if (branch === quitValue) throw quit(mainBranch);
  return branch;
}

// `git switch` carries uncommitted changes to the other branch, and refuses (changing nothing) if they would
// conflict with it, so the owner never loses work here.
async function switchTo(
  args: readonly string[],
  branch: string,
  { git, repoRoot, prompts }: BranchGuardOptions,
): Promise<void> {
  try {
    await git.run(repoRoot, ["switch", ...args]);
    prompts.say(`Switched to ${branch}.`);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    prompts.say(`Could not switch to ${branch}: ${error.stderr || error.message}`);
  }
}

export async function guardBranch(options: BranchGuardOptions): Promise<string | null> {
  const { git, repoRoot, mainBranch, prompts } = options;
  for (;;) {
    const branch = await currentBranch(git, repoRoot);
    if (branch !== mainBranch || !(await hasUncommittedChanges(git, repoRoot))) return branch;
    const branches = await localBranches(git, repoRoot);
    const others = branches.filter((name) => name !== mainBranch);
    const newBranch = unusedBranchName(branches);
    const existing: Choice<GuardChoice>[] =
      others.length > 0 ? [{ value: "existing", label: "Switch to an existing branch…" }] : [];
    const choices: Choice<GuardChoice>[] = [
      {
        value: "new",
        label: `Switch to a new branch "${newBranch}" (keeps your uncommitted changes)`,
      },
      ...existing,
      {
        value: "stay",
        label: `Stay on ${mainBranch} (finished work waits until you commit or stash your changes)`,
      },
      { value: "quit", label: "Quit" },
    ];
    const choice = await prompts.choose(
      `You're on ${mainBranch} with uncommitted changes. Mastermind rebases finished work onto ${mainBranch}, so it waits until they are committed or you work on another branch.`,
      choices,
      "quit",
    );
    if (choice === "quit") throw quit(mainBranch);
    if (choice === "stay") return branch;
    if (choice === "new") await switchTo(["--create", newBranch], newBranch, options);
    else {
      const target = await pickExistingBranch(others, options);
      await switchTo([target], target, options);
    }
  }
}
