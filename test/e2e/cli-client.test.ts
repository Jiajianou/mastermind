import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createActionRegistry, hold, importTasks } from "@mastermind/core/actions";
import { projectPaths } from "@mastermind/core/config";
import { apiResponseSchemas, chatMessageSchema } from "@mastermind/core/contracts";
import type { TaskView } from "@mastermind/core/contracts";
import { openDb } from "@mastermind/core/db";
import { createEventBus } from "@mastermind/core/events";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { makeTempDir } from "../support/cleanup.js";
import { spawnBuiltCli } from "../support/cli.js";
import type { Scenario } from "../support/fake-claude.js";
import { isolatedEnv } from "../support/isolated-env.js";
import type { IsolatedEnv } from "../support/isolated-env.js";
import { startMastermind } from "../support/mastermind.js";
import type { RunningMastermind } from "../support/mastermind.js";
import { waitFor } from "../support/processes.js";
import { createTempRepo } from "../support/temp-repo.js";
import type { TempRepo } from "../support/temp-repo.js";

const seededTasks = `tasks:
  - id: alpha
    title: Alpha
    goal: Build alpha.
    acceptance: "true"
    touches: [src/alpha/]
  - id: gamma
    title: Gamma
    goal: Build gamma on top of alpha.
    acceptance: "true"
    deps: [alpha]
    touches: [src/gamma/]
`;

const workerScenario: Scenario["turns"][number] = {
  match: { role: "worker" },
  steps: [{ kind: "text", text: "Looking around the repo" }, { kind: "hang" }],
};

interface Seed {
  yaml: string;
  held: string[];
  pastSession?: { taskId: string; note: string };
}

interface Running extends RunningMastermind {
  repo: TempRepo;
  env: IsolatedEnv;
}

async function seedDatabase(repo: TempRepo, seed: Seed): Promise<void> {
  const { stateDir, database } = projectPaths(repo.path);
  await mkdir(stateDir, { recursive: true });
  const db = openDb(database);
  try {
    const unusedConfig = {
      set: () => Promise.reject(new Error("seeding tasks never changes the config")),
    };
    const actions = createActionRegistry({ db, bus: createEventBus(), config: unusedConfig }, [
      importTasks,
      hold,
    ]);
    await actions.invoke("importTasks", { yaml: seed.yaml });
    for (const taskId of seed.held) await actions.invoke("hold", { taskId });
    if (seed.pastSession !== undefined) {
      const { taskId, note } = seed.pastSession;
      const session = db.sessions.create({ role: "worker", taskId, attempt: 1 });
      db.events.append({ sessionId: session.id, type: "note", summary: note, payload: note });
      db.sessions.end(session.id, { status: "failed" });
    }
  } finally {
    db.close();
  }
}

async function runningMastermind(scenario: Scenario, seed?: Seed): Promise<Running> {
  const repo = await createTempRepo({ files: { "README.md": "# Demo\n" } });
  await repo.git("switch", "--quiet", "--create", "dev");
  if (seed !== undefined) await seedDatabase(repo, seed);
  const env = await isolatedEnv();
  await env.writeScenario(scenario);
  return { repo, env, ...(await startMastermind(repo, env.env)) };
}

async function tasksJson(running: Running): Promise<TaskView[]> {
  const { code, stdout } = await running.run(["tasks", "--json"]);
  expect(code).toBe(0);
  return apiResponseSchemas.tasks.parse(JSON.parse(stdout));
}

describe("CLI subcommands against the running instance, through the built binary", () => {
  it("says clearly that no mastermind is running for the repo", async () => {
    const repo = await createTempRepo();
    const env = await isolatedEnv();

    const status = spawnBuiltCli(["status", "--repo", repo.path], env.env);
    status.child.stdin.end();

    expect(await status.closed).toBe(1);
    expect(status.output.stderr).toBe(
      `mastermind is not running for ${repo.path}. Start it with \`mastermind .\` in that repo.\n`,
    );
    expect(status.output.stdout).toBe("");
  });

  it("chat streams the Conductor's reply and action line, and the task it added exists", async () => {
    const running = await runningMastermind({
      turns: [
        {
          match: { role: "conductor", prompt: "add a task" },
          steps: [
            { kind: "text", text: "Adding a task for hello.txt now.", streamMs: 200 },
            {
              kind: "mcp",
              tool: "create_tasks",
              arguments: {
                tasks: [
                  {
                    id: "hello",
                    title: "Create hello.txt",
                    goal: "Add hello.txt with a greeting.",
                    acceptance: "test -f hello.txt",
                    touches: ["hello.txt"],
                  },
                ],
              },
            },
            { kind: "text", text: "Added hello; a worker will pick it up." },
          ],
        },
        {
          match: { role: "conductor" },
          steps: [{ kind: "text", text: "A worker is on hello." }],
        },
        workerScenario,
      ],
    });

    const chat = running.spawn(["chat", "add a task to create hello.txt"]);
    await waitFor(() => chat.output.stdout.startsWith("Adding "), 15_000);
    expect(chat.child.exitCode).toBeNull();

    expect(await chat.closed).toBe(0);
    expect(chat.output.stderr).toBe("");
    expect(chat.output.stdout).toBe(
      [
        "Adding a task for hello.txt now.",
        "",
        "Added hello; a worker will pick it up.",
        "✓ Added 1 task",
        "",
      ].join("\n"),
    );
    expect((await tasksJson(running)).map(({ id, title }) => ({ id, title }))).toEqual([
      { id: "hello", title: "Create hello.txt" },
    ]);

    const followUp = await running.run(["chat", "what's running?", "--json"]);
    expect(followUp.code).toBe(0);
    const turn = z
      .object({ turnId: z.string(), messages: z.array(chatMessageSchema) })
      .parse(JSON.parse(followUp.stdout));
    expect(turn.messages.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: "user", content: "what's running?" },
      { kind: "conductor", content: "A worker is on hello." },
    ]);
  });

  it("status and tasks describe the running instance as text and as JSON", async () => {
    const running = await runningMastermind(
      { turns: [workerScenario] },
      { yaml: seededTasks, held: ["alpha"] },
    );

    const status = await running.run(["status"]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/^Tasks +2 pending$/m);
    expect(status.stdout).toMatch(/^Workers +0 of \d+ busy$/m);
    expect(status.stdout).toMatch(/^Running +none$/m);
    expect(status.stdout).toMatch(/^Scheduler +running$/m);

    const statusJson = await running.run(["status", "--json"]);
    expect(apiResponseSchemas.summary.parse(JSON.parse(statusJson.stdout))).toMatchObject({
      counts: { pending: 2, running: 0 },
      activeSessions: [],
      paused: false,
    });

    const tasks = await running.run(["tasks"]);
    expect(tasks.code).toBe(0);
    expect(tasks.stdout.split("\n").map((line) => line.split(/ {2,}/))).toEqual([
      ["ID", "STATUS", "PRIORITY", "DEPS", "TITLE"],
      ["alpha", "pending (held)", "0", "-", "Alpha"],
      ["gamma", "pending", "0", "alpha", "Gamma"],
      [""],
    ]);
    expect(
      (await tasksJson(running)).map(({ id, held, unblocks }) => ({ id, held, unblocks })),
    ).toEqual([
      { id: "alpha", held: true, unblocks: ["gamma"] },
      { id: "gamma", held: false, unblocks: [] },
    ]);
  });

  it("logs -f prints a task's history, then follows the events of its next session", async () => {
    const running = await runningMastermind(
      { turns: [workerScenario] },
      {
        yaml: seededTasks,
        held: ["alpha"],
        pastSession: { taskId: "alpha", note: "Sketched the alpha module" },
      },
    );

    const follow = running.spawn(["logs", "alpha", "-f"]);
    await waitFor(() => follow.output.stdout.includes("ended  failed"), 10_000);
    expect(follow.output.stdout).toMatch(
      /^\d\d:\d\d:\d\d {2}worker +note +Sketched the alpha module$/m,
    );

    expect((await running.run(["release", "alpha"])).code).toBe(0);

    await waitFor(() => follow.output.stdout.includes("Looking around the repo"), 15_000);
    const lines = follow.output.stdout.trimEnd().split("\n");
    expect(lines.slice(0, 2).map((line) => line.slice(10))).toEqual([
      "worker     note   Sketched the alpha module",
      "worker     ended  failed",
    ]);
    expect(lines.at(-1)).toMatch(/^\d\d:\d\d:\d\d {2}worker +note +Looking around the repo$/);
    expect(follow.child.exitCode).toBeNull();

    expect(await running.run(["logs", "gamma"])).toMatchObject({
      code: 0,
      stdout: "No sessions yet for gamma.\n",
    });

    const json = await running.run(["logs", "alpha", "--json"]);
    expect(
      json.stdout
        .trimEnd()
        .split("\n")
        .map((line) => z.object({ summary: z.string() }).parse(JSON.parse(line)).summary),
    ).toEqual(expect.arrayContaining(["Sketched the alpha module", "Looking around the repo"]));
  });

  it("hold, then release, a task, and refuses an unknown one", async () => {
    const running = await runningMastermind(
      { turns: [workerScenario] },
      { yaml: seededTasks, held: ["alpha"] },
    );

    const held = await running.run(["hold", "gamma"]);
    expect(held).toMatchObject({ code: 0, stdout: "hold gamma: now pending (held)\n" });
    expect((await tasksJson(running)).find(({ id }) => id === "gamma")?.held).toBe(true);

    const released = await running.run(["release", "gamma", "--json"]);
    expect(released.code).toBe(0);
    expect(
      apiResponseSchemas.task.omit({ unblocks: true }).parse(JSON.parse(released.stdout)),
    ).toMatchObject({
      id: "gamma",
      held: false,
    });
    expect((await tasksJson(running)).find(({ id }) => id === "gamma")?.held).toBe(false);

    expect(await running.run(["hold", "nope"])).toMatchObject({
      code: 1,
      stdout: "",
      stderr: 'no task "nope"\n',
    });
  });

  it("import, then export, round-trips a tasks.yaml", async () => {
    const running = await runningMastermind({ turns: [workerScenario] });
    const dir = await makeTempDir("tasks-file");
    const canonical = [
      "tasks:",
      "  - id: beta",
      "    title: Beta",
      "    priority: 2",
      "    deps: []",
      "    touches: [ src/beta/ ]",
      "    goal: Build beta.",
      "    acceptance: test -d src/beta",
      "  - id: alpha",
      "    title: Alpha",
      "    deps: []",
      "    touches: [ src/alpha/ ]",
      "    goal: Build alpha.",
      '    acceptance: "true"',
      "  - id: gamma",
      "    title: Gamma",
      "    deps: [ alpha, beta ]",
      "    touches: [ src/gamma/ ]",
      "    goal: |-",
      "      Build gamma",
      "      on top of alpha and beta.",
      '    acceptance: "true"',
      "",
    ].join("\n");
    await writeFile(join(dir, "tasks.yaml"), canonical);

    const imported = await running.run(["import", join(dir, "tasks.yaml")]);
    expect(imported).toMatchObject({
      code: 0,
      stdout: "Imported 3 tasks: beta, alpha, gamma\n",
      stderr: "",
    });

    const exported = await running.run(["export", join(dir, "exported.yaml")]);
    expect(exported.code).toBe(0);
    expect(await readFile(join(dir, "exported.yaml"), "utf8")).toBe(canonical);
    expect(await running.run(["export", "-"])).toMatchObject({ code: 0, stdout: canonical });

    const again = await running.run(["import", join(dir, "exported.yaml")]);
    expect(again).toMatchObject({
      code: 1,
      stderr: [
        'task "beta" already exists',
        'task "alpha" already exists',
        'task "gamma" already exists',
        "",
      ].join("\n"),
    });
  });
});
