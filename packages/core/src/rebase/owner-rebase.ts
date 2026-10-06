import { createWriteStream, existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ActionError } from "../actions/index.js";
import { findAttribution } from "../attribution.js";
import {
  abortRebase,
  conflictedFiles,
  isAncestor,
  quietGit,
  rebaseInProgress,
} from "../checks/rebase.js";
import { describeExit, errorMessage, exitedCleanly, fileStamp } from "../checks/runner.js";
import { systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import type { ResolvedConfig } from "../config/index.js";
import type { BranchRebase, OwnerBranch } from "../contracts/index.js";
import { cleanEnv } from "../env.js";
import type { Environment } from "../env.js";
import type { EventBus } from "../events.js";
import {
  createBranchCopy,
  deleteClone,
  fetchHeadIntoRepo,
  fetchMainIntoClone,
  GitError,
  headCommit,
  upstreamRef,
} from "../git/index.js";
import type { Git } from "../git/index.js";
import type { ExitResult, ProcessRegistry } from "../procs.js";
import type { BranchFixer } from "../sessions/branch-fixer.js";
import { deleteRef, fastForwardMain, mainCheckedOut, readMain } from "./main-ref.js";
import {
  branchTip,
  checkoutIsClean,
  countCommits,
  currentBranch,
  exitedWith,
  mainUpstream,
  readOwnerBranch,
} from "./owner-checkout.js";
import { branchConflictPrompt } from "./owner-prompts.js";

export interface OwnerRebaserOptions {
  git: Git;
  bus: EventBus;
  registry: ProcessRegistry;
  env: Environment;
  repoRoot: string;
  logsDir: string;
  config: () => ResolvedConfig;
  fixer: BranchFixer;
  claudeAllowed: () => boolean;
  signedIn: () => Promise<boolean>;
  onError: (error: unknown) => void;
  clock?: Clock;
}

export interface OwnerRebaseRequest {
  branch?: string | undefined;
}

export interface OwnerRebaser {
  start(): void;
  stop(): void;
  busy(): boolean;
  branch(): Promise<OwnerBranch>;
  rebase(request: OwnerRebaseRequest): Promise<BranchRebase>;
}

interface Job {
  branch: string;
  config: ResolvedConfig;
  copy: string;
  logPath: string;
  fixes: number;
  write(line: string): void;
  close(): Promise<void>;
}

type Final = { kind: "succeeded"; outcome: string } | { kind: "failed"; outcome: string };

type Result = Final | { kind: "retry"; why: string };

interface Ran {
  exit: ExitResult;
  output: string;
}

interface Replaying {
  commit: string;
  head: string;
  subject: string;
  files: readonly string[];
}

export const ownerCopyName = ".owner-branch";

export const ownerBranchRef = (branch: string): string => `refs/mastermind-branches/${branch}`;

const maxTries = 5;
const conflictMarker = "^(<{7}|>{7})( |$)";

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

const refused = (message: string) => ActionError.fromMessage("conflict", message);

export function createOwnerRebaser(options: OwnerRebaserOptions): OwnerRebaser {
  const { git, bus, repoRoot, onError, clock = systemClock } = options;
  const childEnv = cleanEnv(options.env);
  let latest: BranchRebase | null = null;
  let starting = false;
  let running: Promise<void> | null = null;
  let publishing: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | null = null;
  let stopped = false;

  async function branch(): Promise<OwnerBranch> {
    const view = await readOwnerBranch(git, repoRoot, options.config().mainBranch);
    return { ...view, rebase: latest };
  }

  // Serialised, so a slower read never overwrites a newer view.
  function publish(): void {
    publishing = publishing
      .then(async () => {
        const view = await branch();
        bus.emit({ type: "branch.updated", branch: view });
      })
      .catch(onError);
  }

  const failed = (job: Job, reason: string): Final => ({
    kind: "failed",
    outcome: `Couldn't rebase ${job.branch} onto ${job.config.mainBranch}: ${reason}. Both are unchanged; the log is in ${job.logPath}.`,
  });

  async function exec(job: Job, command: string, args: readonly string[]): Promise<Ran> {
    const output: string[] = [];
    const line = (text: string) => {
      job.write(text);
      output.push(text);
    };
    const child = await options.registry.spawn({
      kind: "check",
      command,
      args,
      env: childEnv,
      cwd: job.copy,
      io: { stdin: "ignore", onStdoutLine: line, onStderrLine: line },
    });
    return { exit: await child.exited, output: output.join("\n") };
  }

  async function runCommand(job: Job, name: string, command: string): Promise<Result | null> {
    if (command === "") return null;
    job.write(`$ ${command}`);
    const { exit } = await exec(job, "/bin/sh", ["-c", command]);
    if (exitedCleanly(exit)) return null;
    return failed(job, `the ${name} command ${describeExit(exit)} on the rebased branch`);
  }

  async function conflictMarkers(job: Job, files: readonly string[]): Promise<string[]> {
    try {
      const args = ["grep", "--cached", "-l", "-E", conflictMarker, "--", ...files];
      return (await git.run(job.copy, args)).split("\n").filter((file) => file !== "");
    } catch (error) {
      if (exitedWith(error, 1)) return [];
      throw error;
    }
  }

  async function rebaseHead(job: Job): Promise<string | null> {
    if (!(await rebaseInProgress(git, job.copy))) return null;
    return (await git.run(job.copy, ["rev-parse", "REBASE_HEAD"])).trim();
  }

  // The fixer only resolves; mastermind continues the rebase itself, so the resolution is committed with the
  // owner's own message and authorship and no AI-written commit appears (decision 14).
  async function stageResolution(job: Job, replaying: Replaying): Promise<Result | null> {
    const { subject } = replaying;
    const stillStopped =
      (await rebaseHead(job)) === replaying.commit &&
      (await headCommit(git, job.copy)) === replaying.head;
    if (!stillStopped)
      return failed(job, `the fixer moved the rebase on while resolving "${subject}"`);
    await git.run(job.copy, ["add", "--update"]);
    const unresolved = await conflictedFiles(git, job.copy);
    if (unresolved.length > 0)
      return failed(job, `the fixer left conflicts in ${unresolved.join(", ")}`);
    const marked = await conflictMarkers(job, replaying.files);
    if (marked.length > 0) return failed(job, `conflict markers are left in ${marked.join(", ")}`);
    job.fixes += 1;
    job.write(`Resolved; continuing with the owner's commit "${subject}".`);
    return null;
  }

  async function resolveStop(job: Job, upstream: string, ran: Ran): Promise<Result | null> {
    const { branch: name, config } = job;
    const commit = await rebaseHead(job);
    if (commit === null) return failed(job, `git rebase ${describeExit(ran.exit)}`);
    const files = await conflictedFiles(git, job.copy);
    if (files.length === 0)
      return failed(job, `the rebase stopped without a conflict (git ${describeExit(ran.exit)})`);
    const subject = (await git.run(job.copy, ["log", "-1", "--format=%s", commit])).trim();
    job.write(`Conflict replaying ${commit.slice(0, 7)} "${subject}" in ${files.join(", ")}.`);
    if (!options.claudeAllowed() || !(await options.signedIn()))
      return failed(
        job,
        `replaying "${subject}" conflicts, and no fixer can start while work is paused, signed out or waiting after a usage limit`,
      );
    const head = await headCommit(git, job.copy);
    const fixed = await options.fixer.resolve({
      worktree: job.copy,
      prompt: branchConflictPrompt({
        branch: name,
        mainBranch: config.mainBranch,
        upstream,
        commit,
        subject,
        files,
        output: ran.output,
      }),
    });
    const session = `Fixer session ${String(fixed.session.id)}`;
    if (fixed.kind === "failed") {
      job.write(`${session} failed: ${fixed.reason}`);
      return failed(
        job,
        `the fixer could not resolve the conflict in "${subject}": ${fixed.reason}`,
      );
    }
    job.write(`${session} finished.`);
    return stageResolution(job, { commit, head, subject, files });
  }

  async function replay(job: Job, upstream: string): Promise<Result | null> {
    const { mainBranch } = job.config;
    if (await isAncestor(git, job.copy, upstream)) {
      job.write(`${job.branch} already contains ${mainBranch}.`);
      return null;
    }
    job.write(`$ git rebase upstream/${mainBranch}`);
    let ran = await exec(job, "git", [...quietGit, "rebase", upstreamRef(mainBranch)]);
    while (!exitedCleanly(ran.exit)) {
      const stop = await resolveStop(job, upstream, ran);
      if (stop !== null) {
        await abortRebase(git, job.copy);
        return stop;
      }
      job.write("$ git rebase --continue");
      ran = await exec(job, "git", [...quietGit, "rebase", "--continue"]);
    }
    return null;
  }

  async function attributionIn(upstream: string, commit: string): Promise<string | null> {
    const messages = await git.run(repoRoot, ["log", "--format=%B", `${upstream}..${commit}`]);
    return findAttribution(messages)[0]?.text ?? null;
  }

  async function checkoutChanged(job: Job, tip: string): Promise<Result | null> {
    const { branch: name, config } = job;
    const now = await currentBranch(git, repoRoot);
    if (now !== name)
      return failed(job, `your checkout switched to ${now ?? "a detached HEAD"} meanwhile`);
    if ((await branchTip(git, repoRoot, name)) !== tip)
      return { kind: "retry", why: `${name} moved meanwhile` };
    if (!(await checkoutIsClean(git, repoRoot)))
      return failed(job, `files in your checkout changed meanwhile; commit them, then ask again`);
    if (await mainCheckedOut(git, repoRoot, config.mainBranch))
      return failed(job, `${config.mainBranch} was checked out meanwhile`);
    return null;
  }

  async function succeeded(job: Job, own: number, target: string): Promise<Final> {
    const { branch: name, fixes } = job;
    const { mainBranch } = job.config;
    const fixed =
      fixes === 0
        ? ""
        : `; a fixer resolved conflicts in ${fixes === 1 ? "one" : String(fixes)} of them`;
    const done =
      own === 0
        ? `Moved ${name} to ${mainBranch} (${target.slice(0, 7)}); it had no commits of its own to add.`
        : `Rebased ${name} onto ${mainBranch}: ${plural(own, "commit")} of yours ${own === 1 ? "is" : "are"} on ${mainBranch} now${fixed}.`;
    const upstream = await mainUpstream(git, repoRoot, mainBranch);
    const ahead =
      upstream === null || upstream.ahead === 0
        ? []
        : [`${mainBranch} is ${plural(upstream.ahead, "commit")} ahead of ${upstream.name}.`];
    return { kind: "succeeded", outcome: [done, ...ahead].join(" ") };
  }

  async function moveBranch(job: Job, target: string, own: number): Promise<Final> {
    const { branch: name } = job;
    const { mainBranch } = job.config;
    const moved = () => {
      if (own > 0) bus.emit({ type: "main.moved", branch: mainBranch, commit: target });
    };
    try {
      await git.run(repoRoot, ["reset", "--quiet", "--keep", target]);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      moved();
      return {
        kind: "failed",
        outcome: `${mainBranch} has your commits now, but ${name} couldn't be moved to it: ${error.stderr || error.message}. Run git reset --keep ${mainBranch} in your checkout.`,
      };
    }
    job.write(`Moved ${name} to ${target} with git reset --keep.`);
    moved();
    return succeeded(job, own, target);
  }

  async function attempt(job: Job): Promise<Result> {
    const { branch: name, config, copy } = job;
    const { mainBranch, commands } = config;
    job.fixes = 0;
    const tip = await branchTip(git, repoRoot, name);
    if (existsSync(copy)) await deleteClone(copy, config.worktreeDir);
    await createBranchCopy(git, { repoRoot, branch: name, commit: tip, path: copy });
    job.write(`Copied ${name} at ${tip} to ${copy}.`);
    const setup = await runCommand(job, "setup", commands.setup.trim());
    if (setup !== null) return setup;
    const upstream = await fetchMainIntoClone(git, { repoRoot, mainBranch, clonePath: copy });
    job.write(`Fetched ${mainBranch} at ${upstream}.`);
    const replayed = await replay(job, upstream);
    if (replayed !== null) return replayed;

    const own = await countCommits(git, copy, `${upstream}..HEAD`);
    let target = upstream;
    if (own > 0) {
      for (const [kind, command] of [
        ["build", commands.build],
        ["test", commands.test],
      ] as const) {
        const check = await runCommand(job, kind, command.trim());
        if (check !== null) return check;
      }
      target = await fetchHeadIntoRepo(git, {
        repoRoot,
        clonePath: copy,
        ref: ownerBranchRef(name),
      });
      const attribution = await attributionIn(upstream, target);
      if (attribution !== null)
        return failed(
          job,
          `a commit message has an attribution line (${attribution}); reword it, then ask again`,
        );
      job.write(
        `Attribution guard: no attribution in ${upstream.slice(0, 7)}..${target.slice(0, 7)}.`,
      );
    }

    const changed = await checkoutChanged(job, tip);
    if (changed !== null) return changed;
    if (own > 0) {
      const forward = await fastForwardMain(git, {
        repoRoot,
        mainBranch,
        subject: name,
        from: upstream,
        to: target,
      });
      if (forward.kind === "moved")
        return { kind: "retry", why: `${mainBranch} moved to ${forward.current} meanwhile` };
      job.write(`Fast-forwarded ${mainBranch} from ${upstream} to ${target}.`);
    }
    return moveBranch(job, target, own);
  }

  async function rebaseBranch(job: Job): Promise<Final> {
    for (let tries = 1; tries <= maxTries; tries++) {
      const result = await attempt(job);
      if (result.kind !== "retry") return result;
      job.write(`${result.why}; starting again.`);
    }
    return failed(
      job,
      `${job.config.mainBranch} or ${job.branch} kept moving during ${String(maxTries)} tries`,
    );
  }

  async function cleanUp(job: Job): Promise<void> {
    try {
      await deleteRef(git, repoRoot, ownerBranchRef(job.branch));
      if (existsSync(job.copy)) await deleteClone(job.copy, job.config.worktreeDir);
    } catch (error) {
      onError(error);
    }
  }

  async function run(job: Job): Promise<void> {
    let result: Final;
    try {
      result = await rebaseBranch(job);
    } catch (error) {
      onError(error);
      result = failed(job, errorMessage(error));
    }
    await cleanUp(job);
    job.write(result.outcome);
    await job.close();
    if (latest === null || stopped) return;
    latest = {
      ...latest,
      status: result.kind,
      endedAt: clock.now().toISOString(),
      outcome: result.outcome,
    };
    publish();
  }

  async function openJob(name: string, config: ResolvedConfig): Promise<Job> {
    const logDir = join(options.logsDir, "branches");
    const fileName = name.replace(/[^A-Za-z0-9._-]+/g, "-");
    const logPath = join(logDir, `${fileName}-${fileStamp(clock.now())}.log`);
    await mkdir(logDir, { recursive: true });
    const log = createWriteStream(logPath);
    log.on("error", onError);
    return {
      branch: name,
      config,
      copy: join(config.worktreeDir, ownerCopyName),
      logPath,
      fixes: 0,
      write: (line) => log.write(`${line}\n`),
      close: () => new Promise((resolve) => log.end(resolve)),
    };
  }

  async function ready(
    requested: string | undefined,
  ): Promise<{ name: string; config: ResolvedConfig }> {
    const config = options.config();
    const { mainBranch } = config;
    const name = await currentBranch(git, repoRoot);
    if (name === null)
      throw refused(
        "Your checkout isn't on a branch. Switch to the branch to rebase, then ask again.",
      );
    if (requested !== undefined && requested !== name)
      throw refused(
        `Your checkout is on ${name} now, not ${requested}. Ask again to rebase ${name}.`,
      );
    if (name === mainBranch)
      throw refused(`You're on ${mainBranch}. Switch to your own branch, then ask again.`);
    if (await mainCheckedOut(git, repoRoot, mainBranch))
      throw refused(
        `${mainBranch} is checked out in another worktree. Switch it to another branch first.`,
      );
    if (!(await checkoutIsClean(git, repoRoot)))
      throw refused(
        `Your checkout of ${name} has uncommitted changes. Commit them first, then ask again.`,
      );
    if ((await branchTip(git, repoRoot, name)) === (await readMain(git, repoRoot, mainBranch)))
      throw refused(`${name} is already the same as ${mainBranch}.`);
    return { name, config };
  }

  const busy = (): boolean => starting || running !== null;

  return {
    start() {
      if (unsubscribe !== null) return;
      unsubscribe = bus.subscribe((event) => {
        if (event.type === "main.moved" || event.type === "checkout.updated") publish();
      });
    },

    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
    },

    busy,

    branch,

    async rebase(request) {
      if (busy())
        throw refused(`${latest?.branch ?? "Your branch"} is already being rebased onto main.`);
      starting = true;
      try {
        const { name, config } = await ready(request.branch);
        const job = await openJob(name, config);
        latest = {
          branch: name,
          status: "running",
          startedAt: clock.now().toISOString(),
          endedAt: null,
          outcome: null,
          logPath: job.logPath,
        };
        publish();
        running = run(job)
          .catch(onError)
          .finally(() => {
            running = null;
          });
        return latest;
      } catch (error) {
        // The caller's view of the checkout may be stale (the owner commits and switches outside mastermind).
        publish();
        throw error;
      } finally {
        starting = false;
      }
    },
  };
}
