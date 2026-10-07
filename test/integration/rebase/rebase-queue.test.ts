import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findAttribution } from "@mastermind/core/attribution";
import { postEventLines } from "@mastermind/core/conductor";
import { createMainWatcher } from "@mastermind/core/rebase";
import { describe, expect, it } from "vitest";
import type { Scenario, Step } from "../../support/fake-claude.js";
import { onCleanup } from "../../support/cleanup.js";
import { waitFor } from "../../support/processes.js";
import { owner } from "../../support/temp-repo.js";
import type { TempRepo } from "../../support/temp-repo.js";
import { checksHarness } from "../checks/harness.js";
import type { ChecksHarness, ChecksHarnessOptions } from "../checks/harness.js";

function worker(path: string, ...steps: Step[]): Scenario["turns"][number] {
  return {
    match: { role: "worker", prompt: path },
    steps: [
      { kind: "write", path, content: `${path}\n` },
      { kind: "commit", message: `add ${path}` },
      ...steps,
      { kind: "text", text: "Done." },
    ],
  };
}

async function rebaseHarness(options: ChecksHarnessOptions): Promise<ChecksHarness> {
  const harness = await checksHarness({ startRebaseQueue: true, ...options });
  await harness.repo.git("switch", "--quiet", "--create", "dev");
  return harness;
}

async function startFeature(harness: ChecksHarness, id: string, path: string): Promise<void> {
  await harness.startTask(id, { acceptance: `test -f ${path}`, touches: [path] });
}

const mainLog = (repo: TempRepo, format: string) =>
  repo.git("log", "--first-parent", `--format=${format}`, "main");

async function commitOnMain(repo: TempRepo, path: string, content: string, subject: string) {
  await repo.git("switch", "--quiet", "main");
  await writeFile(join(repo.path, path), content);
  await repo.git("commit", "--quiet", "--all", "--message", subject);
  await repo.git("switch", "--quiet", "dev");
  return repo.git("rev-parse", "main");
}

// The suite moves main once behind mastermind's back, after `onlyIf` lets it through.
const moveMainOnce = (repo: TempRepo, onlyIf: string) =>
  [
    "set -e",
    `REPO='${repo.path}'`,
    "make test",
    onlyIf,
    'test -e "$REPO/.git/moved" && exit 0',
    'touch "$REPO/.git/moved"',
    'c=$(git -C "$REPO" commit-tree "main^{tree}" -p main -m "main: moved meanwhile")',
    'git -C "$REPO" update-ref refs/heads/main "$c"',
  ].join("\n");

describe("rebase queue", () => {
  it("fast-forwards main by exactly one squashed commit, with no merge commit", async () => {
    const harness = await rebaseHarness({
      scenario: {
        turns: [
          worker(
            "src/feature.txt",
            { kind: "write", path: "src/more.txt", content: "more\n" },
            { kind: "commit", message: "WIP: more" },
            { kind: "resultFile", content: "Adds the feature and a second file." },
          ),
        ],
      },
    });
    const initial = await harness.repo.git("rev-parse", "main");

    await startFeature(harness, "feature", "src/feature.txt");
    const task = await harness.waitForStatus("feature", "done");

    const { repo } = harness;
    expect(await repo.git("rev-list", "--count", `${initial}..main`)).toBe("1");
    expect(await repo.git("rev-parse", "main~1")).toBe(initial);
    expect(await repo.git("rev-list", "--merges", "main")).toBe("");
    const message = await repo.git("log", "-1", "--format=%B", "main");
    expect(message).toBe(
      "Build feature\n\nAdds the feature and a second file.\n\nTask id: feature",
    );
    expect(await repo.git("log", "-1", "--format=%an <%ae>|%cn <%ce>", "main")).toBe(
      `${owner.name} <${owner.email}>|${owner.name} <${owner.email}>`,
    );
    expect(await repo.git("show", "main:src/more.txt")).toBe("more");
    expect(await repo.git("symbolic-ref", "--short", "HEAD")).toBe("dev");
    expect(await repo.git("status", "--porcelain", "--untracked-files=no")).toBe("");
    await waitFor(() => !existsSync(task.worktree ?? ""));
    expect(await repo.git("for-each-ref", "refs/mastermind/")).toBe("");

    const rebases = harness.db.rebases.listForTask("feature");
    expect(rebases.map((rebase) => rebase.status)).toEqual(["succeeded"]);
    expect(
      harness.events.flatMap((event) =>
        event.type === "rebase.updated" ? [event.rebase.status] : [],
      ),
    ).toEqual(["running", "succeeded"]);
    expect(harness.events).toContainEqual({
      type: "main.moved",
      branch: "main",
      commit: await repo.git("rev-parse", "main"),
    });
    expect(harness.checks("feature").slice(-3)).toEqual([
      { kind: "rebase", status: "passed" },
      { kind: "build", status: "passed" },
      { kind: "suite", status: "passed" },
    ]);
    expect(harness.errors).toEqual([]);
  });

  it("strips an injected attribution trailer so it never reaches main", async () => {
    const harness = await rebaseHarness({
      scenario: {
        turns: [
          worker(
            "src/feature.txt",
            { kind: "write", path: "src/feature.txt", content: "polished\n" },
            { kind: "commit", message: "polish", trailer: true },
            {
              kind: "resultFile",
              content:
                "Adds the feature.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n",
            },
          ),
        ],
      },
    });

    await startFeature(harness, "credited", "src/feature.txt");
    await harness.waitForStatus("credited", "checking");
    expect(await harness.cloneGit("credited", "log", "--format=%B")).toContain(
      "Co-Authored-By: Claude",
    );
    await harness.waitForStatus("credited", "done");

    const messages = await mainLog(harness.repo, "%B");
    expect(findAttribution(messages)).toEqual([]);
    expect(messages).toContain("Adds the feature.\n\nTask id: credited");
    expect(await harness.repo.git("log", "-1", "--format=%(trailers)", "main")).toBe("");
    expect(harness.errors).toEqual([]);
  });

  it("retries safely when main moves while a task is being rebased onto it", async () => {
    // Only the suite run on the squashed commit (whose message has "Task id:") moves main.
    const harness = await rebaseHarness({
      config: (repo) => ({
        commands: {
          setup: "",
          build: "make build",
          test: moveMainOnce(repo, 'git log -1 --format=%B | grep -q "^Task id:" || exit 0'),
        },
      }),
      scenario: { turns: [worker("src/feature.txt")] },
    });
    const initial = await harness.repo.git("rev-parse", "main");

    await startFeature(harness, "racer", "src/feature.txt");
    await harness.waitForStatus("racer", "done");

    const { repo } = harness;
    expect(await mainLog(repo, "%s")).toBe(
      ["Build racer", "main: moved meanwhile", "Initial commit"].join("\n"),
    );
    expect(await repo.git("rev-parse", "main~2")).toBe(initial);
    expect(await repo.git("rev-list", "--merges", "main")).toBe("");
    const [rebase, ...others] = harness.db.rebases.listForTask("racer");
    expect(others).toEqual([]);
    expect(rebase?.status).toBe("succeeded");
    const log = await readFile(rebase?.logPath ?? "", "utf8");
    expect(log).toMatch(/main moved to [0-9a-f]{40} meanwhile; rebasing again\./);
    expect(harness.checks("racer").filter((check) => check.kind === "rebase")).toHaveLength(3);
    expect(harness.errors).toEqual([]);
  });

  it("sends a suite that fails on the squashed commit to a fixer, counting an attempt, then rebases the fix", async () => {
    // Only the suite run on the squashed commit (whose message has "Task id:") needs the fix.
    const suite = [
      "make test",
      'if git log -1 --format=%B | grep -q "^Task id:" && ! test -f src/fix.txt; then',
      "  echo 'squashed commit lacks src/fix.txt'; exit 1",
      "fi",
    ].join("\n");
    const harness = await rebaseHarness({
      config: { commands: { setup: "", build: "make build", test: suite } },
      scenario: {
        turns: [
          worker("src/feature.txt"),
          {
            match: { role: "fixer", prompt: "lacks src/fix.txt" },
            steps: [
              { kind: "write", path: "src/fix.txt", content: "fix\n" },
              { kind: "commit", message: "add the fix" },
              { kind: "text", text: "Fixed." },
            ],
          },
        ],
      },
    });
    const initial = await harness.repo.git("rev-parse", "main");

    await startFeature(harness, "fragile", "src/feature.txt");
    const task = await harness.waitForStatus("fragile", "done");

    expect(task.attempts).toBe(1);
    expect(harness.db.rebases.listForTask("fragile").map((rebase) => rebase.status)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(
      harness.db.sessions.listForTask("fragile").map(({ role, attempt }) => ({ role, attempt })),
    ).toEqual([
      { role: "worker", attempt: 1 },
      { role: "fixer", attempt: 2 },
    ]);
    const { repo } = harness;
    expect(await repo.git("rev-list", "--count", `${initial}..main`)).toBe("1");
    expect(await repo.git("show", "main:src/fix.txt")).toBe("fix");
    expect(harness.errors).toEqual([]);
  });

  it("pauses rebasing onto main while the owner is on main, and carries on once they switch away", async () => {
    const harness = await checksHarness({
      startRebaseQueue: true,
      scenario: { turns: [worker("src/feature.txt")] },
    });
    const stopLines = postEventLines({
      db: harness.db,
      bus: harness.bus,
      mainBranch: () => "main",
    });
    const initial = await harness.repo.git("rev-parse", "main");

    await startFeature(harness, "patient", "src/feature.txt");
    await waitFor(() =>
      harness.events.some((event) => event.type === "checkout.updated" && event.onMain),
    );

    expect(harness.db.tasks.get("patient")?.status).toBe("rebasing");
    expect(harness.db.rebases.listForTask("patient").map((rebase) => rebase.status)).toEqual([
      "running",
    ]);
    expect(await harness.repo.git("rev-parse", "main")).toBe(initial);
    const prompt = harness.db.chat.list().find((message) => message.kind === "system");
    expect(prompt?.content).toContain("You're on main, so rebasing onto main is paused");
    expect(prompt?.meta).toEqual({ event: "owner_on_main", branch: "main" });

    await harness.repo.git("switch", "--quiet", "--create", "dev");
    await harness.waitForStatus("patient", "done");
    stopLines();

    expect(await harness.repo.git("rev-list", "--count", `${initial}..main`)).toBe("1");
    expect(
      harness.events.flatMap((event) => (event.type === "checkout.updated" ? [event.onMain] : [])),
    ).toEqual([true, false]);
    expect(harness.errors).toEqual([]);
  });

  it("has a fixer resolve a conflict with the new main, then rebases the task onto it", async () => {
    const harness = await rebaseHarness({
      startRebaseQueue: false,
      scenario: {
        turns: [
          worker("src/feature.txt", {
            kind: "edit",
            path: "README.md",
            oldString: "# Demo",
            newString: "# Task demo",
          }),
          {
            match: { role: "fixer", prompt: "## Rebase conflict" },
            steps: [
              {
                kind: "bash",
                command:
                  "git rebase upstream/main >/dev/null 2>&1; printf '# Demo on main and in the task\\n' > README.md && git add README.md && GIT_EDITOR=true git rebase --continue",
              },
              { kind: "text", text: "Rebased." },
            ],
          },
        ],
      },
    });

    await startFeature(harness, "clash", "src/feature.txt");
    await harness.waitForStatus("clash", "rebasing");
    const moved = await commitOnMain(harness.repo, "README.md", "# Main demo\n", "readme: retitle");
    harness.rebaseQueue.start();
    const task = await harness.waitForStatus("clash", "done");

    expect(task.attempts).toBe(0);
    const [fixerPrompt] = await harness.promptsTo("fixer");
    expect(fixerPrompt).toContain("## Rebase conflict");
    expect(harness.db.rebases.listForTask("clash").map((rebase) => rebase.status)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(await harness.repo.git("rev-parse", "main~1")).toBe(moved);
    expect(await harness.repo.git("show", "main:README.md")).toBe("# Demo on main and in the task");
    expect(await harness.repo.git("rev-list", "--merges", "main")).toBe("");
    expect(harness.errors).toEqual([]);
  });

  it("keeps a task in review current when main moves, and rebases it once approved", async () => {
    const harness = await rebaseHarness({
      config: { requireReviewFor: ["src/guarded.txt"] },
      scenario: { turns: [worker("src/guarded.txt"), worker("src/open.txt")] },
    });

    await startFeature(harness, "guarded", "src/guarded.txt");
    await harness.waitForStatus("guarded", "review");
    const reviewChecks = harness.checks("guarded").length;
    await startFeature(harness, "open", "src/open.txt");
    await harness.waitForStatus("open", "done");
    const openOnMain = await harness.repo.git("rev-parse", "main");

    const refreshed = await waitFor(() => {
      const task = harness.db.tasks.get("guarded");
      return task?.status === "review" && task.baseCommit === openOnMain && task;
    });
    expect(harness.checks("guarded").slice(reviewChecks)).toEqual([
      { kind: "rebase", status: "passed" },
      { kind: "suite", status: "passed" },
    ]);
    expect(refreshed.attempts).toBe(0);

    await expect(harness.actions.invoke("approve", { taskId: "open" })).rejects.toThrow(
      "only a task in review can be approved; open is done",
    );
    const approved = await harness.actions.invoke("approve", { taskId: "guarded" });
    expect(approved).toMatchObject({ id: "guarded", status: "rebasing" });
    await harness.waitForStatus("guarded", "done");

    expect(await mainLog(harness.repo, "%s")).toBe(
      ["Build guarded", "Build open", "Initial commit"].join("\n"),
    );
    expect(harness.errors).toEqual([]);
  });

  it("keeps a task in review current when main moves outside mastermind", async () => {
    const harness = await rebaseHarness({
      config: { requireReviewFor: ["src/guarded.txt"] },
      scenario: { turns: [worker("src/guarded.txt")] },
    });
    const watcher = createMainWatcher({
      git: harness.git,
      bus: harness.bus,
      repoRoot: harness.repo.path,
      config: () => harness.config,
      onError: (error) => harness.errors.push(error),
      pollMs: 50,
    });
    watcher.start();
    onCleanup(() => {
      watcher.stop();
    });
    await startFeature(harness, "guarded", "src/guarded.txt");
    await harness.waitForStatus("guarded", "review");
    const reviewChecks = harness.checks("guarded").length;

    const moved = await commitOnMain(harness.repo, "README.md", "# Moved\n", "main: by hand");

    const refreshed = await waitFor(() => {
      const task = harness.db.tasks.get("guarded");
      return task?.status === "review" && task.baseCommit === moved && task;
    });
    expect(harness.events).toContainEqual({ type: "main.moved", branch: "main", commit: moved });
    expect(harness.checks("guarded").slice(reviewChecks)).toEqual([
      { kind: "rebase", status: "passed" },
      { kind: "suite", status: "passed" },
    ]);
    expect(await harness.cloneGit("guarded", "show", "HEAD:README.md")).toBe("# Moved");
    expect(refreshed.attempts).toBe(0);
    expect(harness.errors).toEqual([]);
  });

  it("rebases a task again when main moved while its checks ran, before it waits in review", async () => {
    const harness = await rebaseHarness({
      config: (repo) => ({
        autoRebase: false,
        commands: { setup: "", build: "make build", test: moveMainOnce(repo, "true") },
      }),
      scenario: { turns: [worker("src/feature.txt")] },
    });

    await startFeature(harness, "late", "src/feature.txt");
    await harness.waitForStatus("late", "review");
    const movedMain = await harness.repo.git("rev-parse", "main");
    const current = await waitFor(() => {
      const task = harness.db.tasks.get("late");
      return task?.status === "review" && task.baseCommit === movedMain && task;
    });

    expect(current.attempts).toBe(0);
    expect(harness.checks("late").filter((check) => check.kind === "rebase")).toHaveLength(2);
    expect(harness.errors).toEqual([]);
  });

  it("discards a task in review: its clone and ref are deleted and it returns to pending", async () => {
    const harness = await rebaseHarness({
      config: { autoRebase: false },
      scenario: { turns: [worker("src/feature.txt")] },
    });

    await startFeature(harness, "unwanted", "src/feature.txt");
    const { worktree } = await harness.waitForStatus("unwanted", "review");
    await harness.repo.git(
      "fetch",
      "--quiet",
      worktree ?? "",
      "task/unwanted:refs/mastermind/unwanted",
    );

    const discarded = await harness.actions.invoke("discard", { taskId: "unwanted" });

    expect(discarded).toMatchObject({
      id: "unwanted",
      status: "pending",
      attempts: 0,
      worktree: null,
      branch: null,
      baseCommit: null,
    });
    expect(existsSync(worktree ?? "")).toBe(false);
    expect(await readdir(harness.config.worktreeDir)).toEqual([]);
    expect(await harness.repo.git("for-each-ref", "refs/mastermind/")).toBe("");
    await expect(harness.actions.invoke("discard", { taskId: "unwanted" })).rejects.toThrow(
      "only a task in review or blocked can be discarded; unwanted is pending",
    );
    expect(harness.errors).toEqual([]);
  });
});
