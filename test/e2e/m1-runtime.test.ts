import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { signInPrompt } from "@mastermind/core/auth";
import { createActionRegistry, importTasks } from "@mastermind/core/actions";
import { projectPaths } from "@mastermind/core/config";
import type { Session } from "@mastermind/core/contracts";
import { openDb } from "@mastermind/core/db";
import type { Db } from "@mastermind/core/db";
import { createEventBus } from "@mastermind/core/events";
import { readLock } from "@mastermind/core/lock";
import { startupBanner } from "@mastermind/core/startup";
import { describe, expect, it } from "vitest";
import { spawnBuiltCli } from "../support/cli.js";
import type { CliProcess } from "../support/cli.js";
import { isolatedEnv } from "../support/isolated-env.js";
import type { IsolatedEnv } from "../support/isolated-env.js";
import { openProjectDb } from "../support/mastermind.js";
import { findPids, isAlive, waitFor } from "../support/processes.js";
import { createTempRepo } from "../support/temp-repo.js";
import type { TempRepo } from "../support/temp-repo.js";

const tasksYaml = `tasks:
  - id: alpha
    title: Alpha
    goal: Build alpha.
    acceptance: "true"
    touches: [src/alpha/]
  - id: beta
    title: Beta
    goal: Build beta.
    acceptance: "true"
    touches: [src/beta/]
  - id: gamma
    title: Gamma
    goal: Build gamma on top of alpha and beta.
    acceptance: "true"
    deps: [alpha, beta]
    touches: [src/gamma/]
`;

const parallelTasks = ["alpha", "beta"];

interface Mastermind extends CliProcess {
  exited: Promise<{ code: number | null; at: number }>;
}

async function repoWithTasks(): Promise<TempRepo> {
  const repo = await createTempRepo({
    files: {
      "README.md": "# Demo\n",
      "mastermind.yaml": "maxWorkers: 2\nreviewer: { enabled: false }\n",
    },
  });
  await repo.git("switch", "--quiet", "--create", "dev");
  const { stateDir, database } = projectPaths(repo.path);
  await mkdir(stateDir, { recursive: true });
  const db = openDb(database);
  try {
    const unusedConfig = {
      set: () => Promise.reject(new Error("importing tasks never changes the config")),
    };
    const actions = createActionRegistry({ db, bus: createEventBus(), config: unusedConfig }, [
      importTasks,
    ]);
    await actions.invoke("importTasks", { yaml: tasksYaml });
  } finally {
    db.close();
  }
  return repo;
}

function startMastermind(repo: TempRepo, env: IsolatedEnv, stdin = ""): Mastermind {
  const cli = spawnBuiltCli([repo.path], env.env);
  cli.child.stdin.end(stdin);
  const exited = new Promise<{ code: number | null; at: number }>((resolve) => {
    cli.child.once("exit", (code) => {
      resolve({ code, at: performance.now() });
    });
  });
  return { ...cli, exited };
}

async function waitUntil(mastermind: Mastermind, condition: () => boolean): Promise<void> {
  await waitFor(condition, 20_000).catch((error: unknown) => {
    const { stdout, stderr } = mastermind.output;
    throw new Error(`mastermind did not get there:\n${stdout}${stderr}`, { cause: error });
  });
}

function latestSession(db: Db, taskId: string): Session | undefined {
  return db.sessions.listForTask(taskId).at(-1);
}

function hasTalked(db: Db, session: Session | undefined): boolean {
  return (
    session?.status === "running" &&
    db.events.listForSession(session.id).some((event) => event.type === "note")
  );
}

async function pressCtrlCTwice(
  mastermind: Mastermind,
): Promise<{ code: number | null; ms: number }> {
  mastermind.child.kill("SIGINT");
  await waitUntil(mastermind, () => mastermind.output.stdout.includes("Press Ctrl+C again"));
  const secondPress = performance.now();
  mastermind.child.kill("SIGINT");
  const exit = await mastermind.exited;
  return { code: exit.code, ms: exit.at - secondPress };
}

async function workingEnv(toolMarker: string): Promise<IsolatedEnv> {
  const env = await isolatedEnv();
  await env.writeScenario({
    turns: [
      {
        match: { flags: ["--resume"] },
        steps: [{ kind: "text", text: "Picked up where I left off." }],
      },
      {
        steps: [
          { kind: "spawnGrandchild", marker: toolMarker },
          { kind: "text", text: "Working on it" },
          { kind: "hang" },
        ],
      },
    ],
  });
  return env;
}

async function startParallelWork(repo: TempRepo, env: IsolatedEnv): Promise<Mastermind> {
  const mastermind = startMastermind(repo, env);
  const db = openProjectDb(repo);
  await waitUntil(mastermind, () =>
    parallelTasks.every((id) => hasTalked(db, latestSession(db, id))),
  );
  return mastermind;
}

describe("milestone 1 runtime, through the built binary", () => {
  it("runs two independent tasks in parallel and their dependent only after both, each passing its checks", async () => {
    const repo = await repoWithTasks();
    const env = await isolatedEnv();
    await env.writeScenario({
      turns: [
        {
          steps: [
            { kind: "sleep", ms: 1_000 },
            { kind: "text", text: "Done." },
          ],
        },
      ],
    });
    const db = openProjectDb(repo);

    const mastermind = startMastermind(repo, env);
    await waitUntil(mastermind, () =>
      ["alpha", "beta", "gamma"].every((id) => db.tasks.get(id)?.status === "done"),
    );

    const [alpha, beta, gamma] = ["alpha", "beta", "gamma"].map((id) => latestSession(db, id));
    if (alpha?.endedAt == null || beta?.endedAt == null || gamma === undefined) {
      throw new Error("every task should have one finished worker session");
    }
    expect(alpha.startedAt < beta.endedAt && beta.startedAt < alpha.endedAt).toBe(true);
    for (const id of parallelTasks)
      expect(gamma.startedAt >= (db.tasks.get(id)?.updatedAt ?? "")).toBe(true);
    expect([alpha, beta, gamma].map((session) => session.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });

  it("leaves zero fake-claude processes within 500 ms of the second Ctrl+C", async () => {
    const toolMarker = `tool-${randomUUID()}`;
    const repo = await repoWithTasks();
    const env = await workingEnv(toolMarker);
    const mastermind = await startParallelWork(repo, env);
    const sessionPids = env.livePids();
    const toolPids = findPids(toolMarker);
    expect(sessionPids.length).toBeGreaterThanOrEqual(2);
    expect(toolPids).toHaveLength(2);

    const exit = await pressCtrlCTwice(mastermind);

    expect(exit.code).toBe(130);
    expect(exit.ms).toBeLessThan(500);
    expect(env.livePids()).toEqual([]);
    expect(findPids(toolMarker)).toEqual([]);
    expect([...sessionPids, ...toolPids].filter(isAlive)).toEqual([]);
    expect(readLock(projectPaths(repo.path).stateDir)).toBeNull();
  });

  it("resumes the killed tasks on restart without counting an attempt", async () => {
    const repo = await repoWithTasks();
    const env = await workingEnv(`tool-${randomUUID()}`);
    const killed = await pressCtrlCTwice(await startParallelWork(repo, env));
    expect(killed.code).toBe(130);
    const db = openProjectDb(repo);
    const interrupted = parallelTasks.map((id) => latestSession(db, id)?.claudeSessionId);
    expect(interrupted).toEqual([expect.any(String), expect.any(String)]);

    const restarted = startMastermind(repo, env);
    await waitUntil(restarted, () =>
      parallelTasks.every((id) => db.tasks.get(id)?.status === "done"),
    );

    const resumedIds = (await env.invocations()).flatMap(({ argv }) => {
      const flag = argv.indexOf("--resume");
      return flag === -1 ? [] : [argv[flag + 1]];
    });
    expect(resumedIds.sort()).toEqual([...interrupted].sort());
    for (const id of parallelTasks) {
      expect(db.tasks.get(id)).toMatchObject({ attempts: 0, resumeSession: null });
      expect(db.sessions.listForTask(id).map((session) => session.status)).toEqual([
        "killed",
        "succeeded",
      ]);
    }
    expect(await pressCtrlCTwice(restarted)).toMatchObject({ code: 130 });
  });

  it("offers sign-in when signed out and starts once the login succeeds", async () => {
    const repo = await createTempRepo();
    await repo.git("switch", "--quiet", "--create", "dev");
    const env = await isolatedEnv({
      account: "signed-out",
      env: { FAKE_CLAUDE_LOGIN_ACCOUNT: "max" },
    });

    const mastermind = startMastermind(repo, env, "\n");
    const runningHeader = /^mastermind · .+ · owner@example\.com · Max$/m;
    await waitUntil(mastermind, () => runningHeader.test(mastermind.output.stdout));

    const milestones = [signInPrompt, "✓ Signed in as owner@example.com (Max)", startupBanner];
    const shown = mastermind.output.stdout
      .split("\n")
      .filter((line) => milestones.includes(line) || runningHeader.test(line));
    expect(shown).toEqual([...milestones, expect.stringMatching(runningHeader)]);
    const commands = (await env.invocations()).map(({ argv }) => argv.join(" "));
    expect(commands).toContain("auth login --claudeai");
    expect(await pressCtrlCTwice(mastermind)).toMatchObject({ code: 130 });
  });

  it("refuses to start with an API-key account", async () => {
    const repo = await repoWithTasks();
    const env = await isolatedEnv({ account: "api-key" });

    const mastermind = startMastermind(repo, env);
    const exit = await mastermind.exited;

    expect(exit.code).toBe(1);
    expect(mastermind.output.stdout).toContain(
      "This account uses API billing. Mastermind supports Claude Pro and Max subscriptions only.",
    );
    expect(mastermind.output.stdout).not.toContain(startupBanner);
    const commands = (await env.invocations()).map(({ argv }) => argv.join(" "));
    expect(
      commands.filter((command) => command !== "--version" && command !== "auth status --json"),
    ).toEqual([]);
    expect(readLock(projectPaths(repo.path).stateDir)).toBeNull();
    expect(openProjectDb(repo).sessions.listForTask("alpha")).toEqual([]);
  });
});
