import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { projectPaths } from "@mastermind/core/config";
import { openDb } from "@mastermind/core/db";
import { readLock } from "@mastermind/core/lock";
import { describe, expect, it } from "vitest";
import { onCleanup } from "../support/cleanup.js";
import { spawnCli } from "../support/cli.js";
import { isolatedEnv } from "../support/isolated-env.js";
import { findPids, isAlive, waitFor } from "../support/processes.js";
import { createTempRepo } from "../support/temp-repo.js";

const tasks = [
  { id: "alpha", touches: ["src/alpha/"] },
  { id: "beta", touches: ["src/beta/"] },
  { id: "slow-setup", touches: ["src/slow/"] },
];

async function seedTasks(repoPath: string): Promise<void> {
  const { stateDir, database } = projectPaths(repoPath);
  await mkdir(stateDir, { recursive: true });
  const db = openDb(database);
  for (const { id, touches } of tasks)
    db.tasks.create({ id, title: id, goal: `Build ${id}.`, acceptance: "true", touches });
  db.close();
}

function startMastermind(repoPath: string, env: Record<string, string>, stdin = "") {
  const cli = spawnCli([repoPath], env);
  cli.child.stdin.end(stdin);
  const exited = new Promise<{ code: number | null; at: number }>((resolve) => {
    cli.child.once("exit", (code) => {
      resolve({ code, at: performance.now() });
    });
  });
  return { ...cli, exited };
}

describe("the kill path", () => {
  it("on Ctrl+C twice, kills every session and check within 500 ms, marks them killed and releases the lock", async () => {
    const setupMarker = `setup-${randomUUID()}`;
    const toolMarker = `tool-${randomUUID()}`;
    const repo = await createTempRepo({
      files: {
        "README.md": "# Demo\n",
        "mastermind.yaml": [
          "maxWorkers: 3",
          "commands:",
          `  setup: 'if [ "$(basename "$PWD")" = slow-setup ]; then sleep 300; fi # ${setupMarker}'`,
          "",
        ].join("\n"),
      },
    });
    await repo.git("switch", "--quiet", "--create", "dev");
    const env = await isolatedEnv();
    await env.writeScenario({
      turns: [
        {
          steps: [
            { kind: "spawnGrandchild", marker: toolMarker },
            { kind: "text", text: "Working on it" },
            { kind: "hang" },
          ],
        },
      ],
    });
    await seedTasks(repo.path);

    const mastermind = startMastermind(repo.path, env.env);
    const { output } = mastermind;
    await waitFor(
      () =>
        /alpha\s+Start worker/.test(output.stdout) &&
        /beta\s+Start worker/.test(output.stdout) &&
        /slow-setup\s+Setup check running/.test(output.stdout) &&
        findPids(toolMarker).length === 2 &&
        findPids(setupMarker).length > 0,
      20_000,
    ).catch((error: unknown) => {
      throw new Error(`mastermind did not start its sessions:\n${output.stdout}${output.stderr}`, {
        cause: error,
      });
    });
    const sessionPids = env.livePids();
    const toolPids = findPids(toolMarker);
    const setupPids = findPids(setupMarker);

    mastermind.child.kill("SIGINT");
    await waitFor(() =>
      output.stdout.includes(
        "Press Ctrl+C again to quit. This kills 2 sessions and 1 check immediately. Worktrees are kept.",
      ),
    );
    expect(sessionPids.every(isAlive)).toBe(true);
    const secondPress = performance.now();
    mastermind.child.kill("SIGINT");
    const exit = await mastermind.exited;

    expect(exit.code).toBe(130);
    expect(exit.at - secondPress).toBeLessThan(500);
    expect(output.stdout).toContain(
      "Stopped mastermind. Killed 2 sessions, 1 check.\nWorktrees kept. Unfinished tasks resume on the next `mastermind .`\n",
    );
    expect(env.livePids()).toEqual([]);
    expect([...sessionPids, ...toolPids, ...setupPids].filter(isAlive)).toEqual([]);

    const { stateDir, database } = projectPaths(repo.path);
    expect(readLock(stateDir)).toBeNull();
    const db = openDb(database);
    onCleanup(() => {
      db.close();
    });
    expect(db.sessions.listRunning()).toEqual([]);
    expect(tasks.flatMap(({ id }) => db.sessions.listForTask(id)).map((s) => s.status)).toEqual([
      "killed",
      "killed",
    ]);
    expect(db.checks.listForTask("slow-setup").map((check) => check.status)).toEqual(["killed"]);
  });

  it("during startup, a single Ctrl+C kills the waiting login hand-off and exits", async () => {
    const repo = await createTempRepo();
    await repo.git("switch", "--quiet", "--create", "dev");
    const env = await isolatedEnv({
      account: "signed-out",
      env: { FAKE_CLAUDE_LOGIN_WAIT: "1" },
    });

    const mastermind = startMastermind(repo.path, env.env, "\n");
    const loginPids = await waitFor(async () => {
      const loggingIn = (await env.invocations()).some(({ argv }) => argv.includes("login"));
      const pids = env.livePids();
      return loggingIn && pids.length > 0 && pids;
    }, 20_000);
    mastermind.child.kill("SIGINT");
    const exit = await mastermind.exited;

    expect(exit.code).toBe(130);
    expect(loginPids.filter(isAlive)).toEqual([]);
    expect(env.livePids()).toEqual([]);
  });
});
