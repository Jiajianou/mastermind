import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findAttribution } from "@mastermind/core/attribution";
import type { Task } from "@mastermind/core/contracts";
import type { Db } from "@mastermind/core/db";
import { describe, expect, it } from "vitest";
import type { Scenario, Step } from "../support/fake-claude.js";
import { isolatedEnv } from "../support/isolated-env.js";
import type { IsolatedEnv } from "../support/isolated-env.js";
import { openProjectDb, startMastermind } from "../support/mastermind.js";
import type { RunningMastermind } from "../support/mastermind.js";
import { waitFor } from "../support/processes.js";
import { createTempRepo, owner } from "../support/temp-repo.js";
import type { TempRepo } from "../support/temp-repo.js";

type Turn = Scenario["turns"][number];

interface TaskSpec {
  id: string;
  title: string;
  path: string;
  acceptance?: string;
  touches?: string[];
}

interface Project {
  repo: TempRepo;
  env: IsolatedEnv;
  db: Db;
  running: RunningMastermind;
  initialMain: string;
  waitForStatus(id: string, status: Task["status"]): Promise<Task>;
  editingSessions(id: string): { role: string; attempt: number | null; status: string }[];
}

const makefile = `build:
\t@echo built
test:
\t@echo tests passed
`;

const throughTheQueue = 45_000;

const notFlaky: Turn = {
  match: { flags: ["--max-turns"] },
  steps: [{ kind: "structuredOutput", output: { flaky: false, reason: "The file is wrong." } }],
};

const noFindings: Turn = {
  match: { role: "reviewer" },
  steps: [{ kind: "structuredOutput", output: { findings: [] } }],
};

function worker(task: TaskSpec, ...steps: Step[]): Turn {
  return {
    match: { role: "worker", prompt: `# Task ${task.id}:` },
    steps: [...steps, { kind: "text", text: "Done." }],
  };
}

function tasksYaml(tasks: readonly TaskSpec[]): string {
  const entries = tasks.map(({ id, title, path, acceptance, touches }) =>
    [
      `  - id: ${id}`,
      `    title: ${JSON.stringify(title)}`,
      `    goal: Write ${path}.`,
      `    acceptance: ${JSON.stringify(acceptance ?? `test -f ${path}`)}`,
      `    touches: ${JSON.stringify(touches ?? [path])}`,
    ].join("\n"),
  );
  return `tasks:\n${entries.join("\n")}\n`;
}

async function runProject(
  mastermindYaml: string,
  tasks: readonly TaskSpec[],
  scenario: (repo: TempRepo) => Scenario,
): Promise<Project> {
  const repo = await createTempRepo({
    files: { "README.md": "# Demo\n", Makefile: makefile, "mastermind.yaml": mastermindYaml },
  });
  await repo.git("switch", "--quiet", "--create", "dev");
  const env = await isolatedEnv();
  await env.writeScenario(scenario(repo));
  const initialMain = await repo.git("rev-parse", "main");
  const running = await startMastermind(repo, env.env);
  const db = openProjectDb(repo);

  const tasksFile = join(env.root, "tasks.yaml");
  await writeFile(tasksFile, tasksYaml(tasks));
  const imported = await running.run(["import", tasksFile]);
  expect(imported).toMatchObject({ code: 0, stderr: "" });

  return {
    repo,
    env,
    db,
    running,
    initialMain,
    async waitForStatus(id, status) {
      return waitFor(() => {
        const task = db.tasks.get(id);
        return task?.status === status && task;
      }, throughTheQueue).catch((error: unknown) => {
        const { stdout, stderr } = running.mastermind.output;
        const seen = db.tasks.get(id)?.status ?? "missing";
        throw new Error(`${id} never became ${status} (it is ${seen}):\n${stdout}${stderr}`, {
          cause: error,
        });
      });
    },
    editingSessions: (id) =>
      db.sessions
        .listForTask(id)
        .filter((session) => session.role === "worker" || session.role === "fixer")
        .map(({ role, attempt, status }) => ({ role, attempt, status })),
  };
}

const firstParents = (repo: TempRepo, format: string) =>
  repo.git("log", "--first-parent", `--format=${format}`, "main");

describe("milestone 5: checks, fixers and the rebase queue, through the built binary", () => {
  it("rebases a passing task onto main as one fast-forwarded commit, stripping injected attribution", async () => {
    const credited: TaskSpec = {
      id: "credited",
      title: "Add the feature",
      path: "src/feature.txt",
    };
    const project = await runProject("reviewer: { enabled: true }\n", [credited], () => ({
      turns: [
        worker(
          credited,
          { kind: "write", path: credited.path, content: "feature\n" },
          { kind: "commit", message: "feature: first pass" },
          { kind: "write", path: credited.path, content: "polished feature\n" },
          { kind: "commit", message: "feature: polish", trailer: true },
          {
            kind: "resultFile",
            content:
              "Adds the feature.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n",
          },
        ),
        noFindings,
      ],
    }));
    const { repo, db } = project;

    const task = await project.waitForStatus("credited", "done");

    expect(await repo.git("rev-list", "--count", `${project.initialMain}..main`)).toBe("1");
    expect(await repo.git("rev-parse", "main~1")).toBe(project.initialMain);
    expect(await repo.git("rev-list", "--merges", "main")).toBe("");
    expect(await repo.git("show", `main:${credited.path}`)).toBe("polished feature");
    const message = await repo.git("log", "-1", "--format=%B", "main");
    expect(message).toBe("Add the feature\n\nAdds the feature.\n\nTask id: credited");
    expect(findAttribution(await firstParents(repo, "%B"))).toEqual([]);
    expect(await repo.git("log", "-1", "--format=%(trailers)", "main")).toBe("");
    expect(await repo.git("log", "-1", "--format=%an <%ae>", "main")).toBe(
      `${owner.name} <${owner.email}>`,
    );

    expect(await repo.git("symbolic-ref", "--short", "HEAD")).toBe("dev");
    expect(await repo.git("for-each-ref", "refs/mastermind/")).toBe("");
    expect(task.worktree).toEqual(expect.any(String));
    expect(existsSync(task.worktree ?? "")).toBe(false);
    expect(task.attempts).toBe(0);
    expect(db.rebases.listForTask("credited").map((rebase) => rebase.status)).toEqual([
      "succeeded",
    ]);
  });

  it("has a fixer resolve a branch that conflicts with main, then rebases it onto main", async () => {
    const retitle: TaskSpec = { id: "retitle", title: "Retitle the demo", path: "README.md" };
    const clash: TaskSpec = { id: "clash", title: "Add the clash file", path: "src/clash.txt" };
    const resolved = "# Retitled demo with a clash\n";
    const project = await runProject("maxWorkers: 2\n", [retitle, clash], (repo) => ({
      turns: [
        worker(
          retitle,
          { kind: "edit", path: "README.md", oldString: "# Demo", newString: "# Retitled demo" },
          { kind: "commit", message: "readme: retitle" },
        ),
        // clash strays outside its touches into README.md, and finishes only once retitle is on main.
        worker(
          clash,
          { kind: "write", path: clash.path, content: "clash\n" },
          { kind: "edit", path: "README.md", oldString: "# Demo", newString: "# Clash demo" },
          { kind: "commit", message: "clash: add the file" },
          {
            kind: "bash",
            command: `for i in $(seq 300); do git -C '${repo.path}' log --format=%s main | grep -qx '${retitle.title}' && exit 0; sleep 0.1; done; exit 1`,
          },
        ),
        {
          match: { role: "fixer", prompt: "## Rebase conflict" },
          steps: [
            { kind: "bash", command: "git rebase upstream/main >/dev/null 2>&1; true" },
            { kind: "write", path: "README.md", content: resolved },
            {
              kind: "bash",
              command: "git add README.md && GIT_EDITOR=true git rebase --continue",
            },
            { kind: "text", text: "Resolved the README conflict." },
          ],
        },
        noFindings,
      ],
    }));
    const { repo, db } = project;

    await project.waitForStatus("retitle", "done");
    const retitled = await repo.git("rev-parse", "main");
    await project.waitForStatus("clash", "done");

    expect(await firstParents(repo, "%s")).toBe(
      [clash.title, retitle.title, "Initial commit"].join("\n"),
    );
    expect(await repo.git("rev-parse", "main~1")).toBe(retitled);
    expect(await repo.git("rev-list", "--merges", "main")).toBe("");
    expect(await repo.git("show", "main:README.md")).toBe(resolved.trimEnd());
    expect(await repo.git("show", `main:${clash.path}`)).toBe("clash");

    expect(db.tasks.get("clash")?.attempts).toBe(0);
    expect(project.editingSessions("clash")).toEqual([
      { role: "worker", attempt: 1, status: "succeeded" },
      { role: "fixer", attempt: 1, status: "succeeded" },
    ]);
    const checks = db.checks.listForTask("clash").map(({ kind, status }) => ({ kind, status }));
    expect(checks.filter((check) => check.kind === "rebase")).toEqual([
      { kind: "rebase", status: "failed" },
      { kind: "rebase", status: "passed" },
      { kind: "rebase", status: "passed" },
    ]);
    const fixerPrompts = (await project.env.readLog()).flatMap((record) =>
      record.kind === "message" && record.text.includes("## Rebase conflict") ? [record.text] : [],
    );
    expect(fixerPrompts).toEqual([expect.stringContaining("README.md")]);
  });

  it("sends a failing task to a fixer, then blocks it after maxAttempts and leaves main alone", async () => {
    const stubborn: TaskSpec = {
      id: "stubborn",
      title: "Make the file ready",
      path: "src/ready.txt",
      acceptance: "grep -q ready src/ready.txt",
    };
    const project = await runProject("maxAttempts: 2\n", [stubborn], () => ({
      turns: [
        worker(
          stubborn,
          { kind: "write", path: stubborn.path, content: "draft\n" },
          { kind: "commit", message: "ready: first draft" },
        ),
        notFlaky,
        { match: { role: "fixer" }, steps: [{ kind: "text", text: "I could not fix it." }] },
      ],
    }));
    const { repo, db } = project;

    const task = await project.waitForStatus("stubborn", "blocked");

    expect(task.attempts).toBe(2);
    expect(project.editingSessions("stubborn")).toEqual([
      { role: "worker", attempt: 1, status: "succeeded" },
      { role: "fixer", attempt: 2, status: "succeeded" },
    ]);
    const checks = db.checks.listForTask("stubborn").map(({ kind, status }) => ({ kind, status }));
    expect(checks).toEqual([
      { kind: "build", status: "passed" },
      { kind: "acceptance", status: "failed" },
      { kind: "build", status: "passed" },
      { kind: "acceptance", status: "failed" },
    ]);
    const fixerLastEvents = db.sessions
      .listForTask("stubborn")
      .filter((session) => session.role === "fixer")
      .flatMap((fixer) => db.events.listForSession(fixer.id).slice(-1))
      .map(({ type, summary }) => ({ type, summary }));
    expect(fixerLastEvents).toHaveLength(1);
    expect(fixerLastEvents[0]?.type).toBe("error");
    expect(fixerLastEvents[0]?.summary).toMatch(
      /^Blocked after 2 attempts: the acceptance check failed/,
    );
    const listed = await project.running.run(["tasks"]);
    expect(listed).toMatchObject({ code: 0, stderr: "" });
    expect(listed.stdout).toMatch(/stubborn.*blocked/);

    expect(await repo.git("rev-parse", "main")).toBe(project.initialMain);
    expect(db.rebases.listForTask("stubborn")).toEqual([]);
    expect(existsSync(task.worktree ?? "")).toBe(true);
  });
});
