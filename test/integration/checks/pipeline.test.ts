import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Scenario, Step } from "../../support/fake-claude.js";
import { waitFor } from "../../support/processes.js";
import { checksHarness } from "./harness.js";

const notFlaky: Scenario["turns"][number] = {
  match: { flags: ["--max-turns"] },
  steps: [
    { kind: "structuredOutput", output: { flaky: false, reason: "The code makes it fail." } },
  ],
};

function worker(...steps: Step[]): Scenario["turns"][number] {
  return {
    match: { role: "worker" },
    steps: [
      { kind: "write", path: "src/feature.txt", content: "feature\n" },
      ...steps,
      { kind: "commit", message: "feature: add it" },
      { kind: "text", text: "Done." },
    ],
  };
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function jsonFlag(argv: readonly string[], flag: string): unknown {
  return JSON.parse(flagValue(argv, flag) ?? "null");
}

describe("checks pipeline", () => {
  it("sends a failing build to a fixer, counts the attempt, and moves the fixed task on to rebasing", async () => {
    const harness = await checksHarness({
      scenario: {
        turns: [
          worker({ kind: "write", path: "BROKEN", content: "x\n" }),
          notFlaky,
          {
            match: { role: "fixer" },
            steps: [
              { kind: "bash", command: "git rm -q BROKEN && git commit -qm 'build: drop BROKEN'" },
              { kind: "text", text: "Fixed." },
            ],
          },
        ],
      },
    });

    await harness.startTask("feature");
    const task = await harness.waitForStatus("feature", "rebasing");

    expect(task.attempts).toBe(1);
    expect(harness.checks("feature")).toEqual([
      { kind: "build", status: "failed" },
      { kind: "build", status: "passed" },
      { kind: "acceptance", status: "passed" },
      { kind: "rebase", status: "passed" },
      { kind: "suite", status: "passed" },
    ]);
    const sessions = harness.db.sessions.listForTask("feature");
    expect(sessions.map(({ role, attempt, status }) => ({ role, attempt, status }))).toEqual([
      { role: "worker", attempt: 1, status: "succeeded" },
      { role: "judge", attempt: null, status: "succeeded" },
      { role: "fixer", attempt: 2, status: "succeeded" },
    ]);

    const [failedBuild] = harness.db.checks.listForTask("feature");
    expect(failedBuild?.summary).toBe("make build exited with code 2");
    expect(await readFile(failedBuild?.logPath ?? "", "utf8")).toContain(
      "build failed: BROKEN is present",
    );
    for (const check of harness.db.checks.listForTask("feature")) {
      expect(check.durationMs).toBeGreaterThanOrEqual(0);
      const updates = harness.events.flatMap((event) =>
        event.type === "check.updated" && event.check.id === check.id ? [event.check.status] : [],
      );
      expect(updates).toEqual(["running", check.status]);
    }

    const [fixerPrompt] = await harness.promptsTo("fixer");
    expect(fixerPrompt).toContain("## The build check failed");
    expect(fixerPrompt).toContain("build failed: BROKEN is present");
    const [fixer] = await harness.invocationsOf("fixer");
    expect(fixer?.cwd).toBe(task.worktree);
    expect(flagValue(fixer?.argv ?? [], "--model")).toBe("opus");
    const [judge] = await harness.invocationsOf("judge");
    expect({
      model: flagValue(judge?.argv ?? [], "--model"),
      maxTurns: flagValue(judge?.argv ?? [], "--max-turns"),
      tools: flagValue(judge?.argv ?? [], "--tools"),
      input: flagValue(judge?.argv ?? [], "--input-format"),
      schema: jsonFlag(judge?.argv ?? [], "--json-schema"),
    }).toMatchObject({
      model: "haiku",
      maxTurns: "1",
      tools: "",
      input: "text",
      schema: { type: "object", required: ["flaky", "reason"] },
    });
    expect(harness.errors).toEqual([]);
  });

  it("blocks a task whose checks still fail after maxAttempts, with an event saying why", async () => {
    const harness = await checksHarness({
      config: { maxAttempts: 2 },
      scenario: {
        turns: [
          worker({ kind: "write", path: "BROKEN", content: "x\n" }),
          notFlaky,
          { match: { role: "fixer" }, steps: [{ kind: "text", text: "I could not fix it." }] },
        ],
      },
    });

    await harness.startTask("stubborn");
    const task = await harness.waitForStatus("stubborn", "blocked");

    expect(task.attempts).toBe(2);
    const editing = harness.db.sessions
      .listForTask("stubborn")
      .filter((session) => session.role !== "judge");
    expect(editing.map(({ role, attempt }) => ({ role, attempt }))).toEqual([
      { role: "worker", attempt: 1 },
      { role: "fixer", attempt: 2 },
    ]);
    const lastEvent = harness.db.events.listForSession(editing[1]?.id ?? 0).at(-1);
    expect(lastEvent).toMatchObject({
      type: "error",
      summary: "Blocked after 2 attempts: the build check failed: make build exited with code 2",
    });
    expect(harness.checks("stubborn")).toEqual([
      { kind: "build", status: "failed" },
      { kind: "build", status: "failed" },
    ]);
    expect(await harness.invocationsOf("fixer")).toHaveLength(1);
    expect(harness.errors).toEqual([]);
  });

  it("re-runs a failure the judge calls flaky once, without a fixer or an attempt", async () => {
    const harness = await checksHarness({
      scenario: {
        turns: [
          worker({ kind: "write", path: "FLAKY", content: "x\n" }),
          {
            match: { flags: ["--max-turns"] },
            steps: [
              {
                kind: "structuredOutput",
                output: { flaky: true, reason: "A dropped connection." },
              },
            ],
          },
        ],
      },
    });

    await harness.startTask("wobbly");
    const task = await harness.waitForStatus("wobbly", "rebasing");

    expect(task.attempts).toBe(0);
    expect(harness.checks("wobbly").slice(0, 2)).toEqual([
      { kind: "build", status: "failed" },
      { kind: "build", status: "passed" },
    ]);
    const rerun = harness.db.checks.listForTask("wobbly")[1];
    expect(await readFile(rerun?.logPath ?? "", "utf8")).toContain(
      "Re-run because the failure looked flaky: A dropped connection.",
    );
    expect(harness.db.sessions.listForTask("wobbly").map((session) => session.role)).toEqual([
      "worker",
      "judge",
    ]);
  });

  it("aborts a conflicting rebase and has a fixer redo it, without counting an attempt", async () => {
    const harness = await checksHarness({
      startPipeline: false,
      scenario: {
        turns: [
          worker({
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
    await harness.startTask("readme");
    await harness.waitForStatus("readme", "checking");
    await writeFile(join(harness.repo.path, "README.md"), "# Main demo\n");
    await harness.repo.git("commit", "-qam", "readme: retitle on main");
    const main = await harness.repo.git("rev-parse", "main");

    harness.pipeline.start();
    const task = await harness.waitForStatus("readme", "rebasing");

    expect(task).toMatchObject({ attempts: 0, baseCommit: main });
    expect(harness.checks("readme")).toEqual([
      { kind: "build", status: "passed" },
      { kind: "acceptance", status: "passed" },
      { kind: "rebase", status: "failed" },
      { kind: "build", status: "passed" },
      { kind: "acceptance", status: "passed" },
      { kind: "rebase", status: "passed" },
      { kind: "suite", status: "passed" },
    ]);
    const [fixerPrompt] = await harness.promptsTo("fixer");
    expect(fixerPrompt).toContain("CONFLICT");
    expect(fixerPrompt).toContain("README.md");
    expect(harness.db.sessions.listForTask("readme").map((session) => session.attempt)).toEqual([
      1, 1,
    ]);
    expect(await harness.cloneGit("readme", "merge-base", "--is-ancestor", main, "HEAD")).toBe("");
    expect(await harness.cloneGit("readme", "rev-list", "--merges", "HEAD")).toBe("");
    expect(await harness.cloneGit("readme", "show", "HEAD:README.md")).toBe(
      "# Demo on main and in the task",
    );
    expect(harness.errors).toEqual([]);
  });

  it("sends a serious review finding to a fixer, then stores a minor one and lets the task proceed", async () => {
    const harness = await checksHarness({
      config: { reviewer: { enabled: true } },
      scenario: {
        turns: [
          {
            match: { role: "worker" },
            steps: [
              { kind: "write", path: "src/feature.txt", content: "TODO: finish\n" },
              { kind: "commit", message: "feature: start it" },
            ],
          },
          {
            match: { role: "reviewer", prompt: "TODO" },
            steps: [
              {
                kind: "structuredOutput",
                output: {
                  findings: [
                    {
                      file: "src/feature.txt",
                      line: 1,
                      text: "The feature is still a TODO.",
                      severity: "serious",
                    },
                  ],
                },
              },
            ],
          },
          {
            match: { role: "reviewer" },
            steps: [
              {
                kind: "structuredOutput",
                output: {
                  findings: [
                    {
                      file: "src/feature.txt",
                      line: null,
                      text: "Say what the feature is.",
                      severity: "minor",
                    },
                  ],
                },
              },
            ],
          },
          {
            match: { role: "fixer" },
            steps: [
              {
                kind: "bash",
                command:
                  "printf 'feature\\n' > src/feature.txt && git commit -qam 'feature: finish it'",
              },
            ],
          },
        ],
      },
    });

    await harness.startTask("reviewed");
    const task = await harness.waitForStatus("reviewed", "rebasing");

    expect(task.attempts).toBe(1);
    expect(
      harness.db.findings.listForTask("reviewed").map(({ severity, line, text }) => ({
        severity,
        line,
        text,
      })),
    ).toEqual([
      { severity: "serious", line: 1, text: "The feature is still a TODO." },
      { severity: "minor", line: null, text: "Say what the feature is." },
    ]);
    const reviews = harness.db.checks
      .listForTask("reviewed")
      .filter((check) => check.kind === "reviewer");
    expect(reviews.map(({ status, summary }) => ({ status, summary }))).toEqual([
      { status: "failed", summary: "1 finding: 1 serious, 0 minor" },
      { status: "passed", summary: "1 finding: 0 serious, 1 minor" },
    ]);
    const [fixerPrompt] = await harness.promptsTo("fixer");
    expect(fixerPrompt).toContain("- src/feature.txt:1: The feature is still a TODO.");
    const [reviewer] = await harness.invocationsOf("reviewer");
    const argv = reviewer?.argv ?? [];
    expect(argv.slice(argv.indexOf("--tools"), argv.indexOf("--tools") + 4)).toEqual([
      "--tools",
      "Read",
      "Grep",
      "Glob",
    ]);
    expect(flagValue(argv, "--model")).toBe("sonnet");
    expect(jsonFlag(argv, "--json-schema")).toMatchObject({
      properties: { findings: { type: "array" } },
    });
    expect(harness.errors).toEqual([]);
  });

  it("holds a task that touches a protected path for review, and re-runs its checks on request", async () => {
    const harness = await checksHarness({
      config: { requireReviewFor: ["src/"] },
      scenario: { turns: [worker()] },
    });

    await harness.startTask("guarded");
    await harness.waitForStatus("guarded", "review");
    const rerun = await harness.actions.invoke("rerunChecks", { taskId: "guarded" });
    await harness.waitForStatus("guarded", "review");

    expect(rerun).toMatchObject({ id: "guarded", status: "checking" });
    const round = [
      { kind: "build", status: "passed" },
      { kind: "acceptance", status: "passed" },
      { kind: "rebase", status: "passed" },
      { kind: "suite", status: "passed" },
    ];
    expect(harness.checks("guarded")).toEqual([...round, ...round]);
    await expect(harness.actions.invoke("rerunChecks", { taskId: "nope" })).rejects.toThrow(
      'no task "nope"',
    );
    expect(harness.errors).toEqual([]);
  });

  it("drops a run whose task is steered back to work, then checks the steered branch", async () => {
    const holdFirstBuild =
      "g=$(git rev-parse --git-dir); if [ ! -e $g/held ]; then touch $g/held; while [ ! -e $g/release ]; do sleep 0.05; done; fi; make build";
    const harness = await checksHarness({
      config: { commands: { setup: "", build: holdFirstBuild, test: "make test" } },
      scenario: {
        turns: [
          {
            match: { role: "worker", prompt: "Add notes too." },
            steps: [
              { kind: "write", path: "src/notes.txt", content: "notes\n" },
              { kind: "commit", message: "feature: add notes" },
            ],
          },
          worker(),
        ],
      },
    });

    await harness.startTask("steered");
    const { worktree } = await harness.waitForStatus("steered", "checking");
    const gitDir = join(worktree ?? "", ".git");
    await waitFor(() => existsSync(join(gitDir, "held")));
    const [first] = harness.db.sessions.listForTask("steered");
    await harness.manager.messageSession(first?.id ?? 0, "Add notes too.");
    await waitFor(() => harness.db.sessions.listForTask("steered")[1]?.status === "succeeded");
    await writeFile(join(gitDir, "release"), "");
    await harness.waitForStatus("steered", "rebasing");

    expect(harness.checks("steered")).toEqual([
      { kind: "build", status: "passed" },
      { kind: "build", status: "passed" },
      { kind: "acceptance", status: "passed" },
      { kind: "rebase", status: "passed" },
      { kind: "suite", status: "passed" },
    ]);
    expect(await harness.cloneGit("steered", "show", "HEAD:src/notes.txt")).toBe("notes");
    expect(harness.errors).toEqual([]);
  });
});
