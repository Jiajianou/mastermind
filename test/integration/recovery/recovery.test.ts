import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "@mastermind/core/db";
import type { Db } from "@mastermind/core/db";
import { createGit } from "@mastermind/core/git";
import { createProcessRegistry } from "@mastermind/core/procs";
import { interruptedMessage, recoverPreviousRun } from "@mastermind/core/recovery";
import { describe, expect, it } from "vitest";
import { makeTempDir, onCleanup } from "../../support/cleanup.js";
import { isolatedEnv } from "../../support/isolated-env.js";
import type { IsolatedEnv } from "../../support/isolated-env.js";
import {
  findPids,
  isAlive,
  startUnrelatedProcess,
  trackChild,
  waitFor,
} from "../../support/processes.js";
import { createTempRepo } from "../../support/temp-repo.js";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const promptsDir = join(workspaceRoot, "prompts");
const previousRunScript = fileURLToPath(new URL("previous-run.ts", import.meta.url));

function openTestDb(path: string): Db {
  const db = openDb(path);
  onCleanup(() => {
    db.close();
  });
  return db;
}

function gitFor(env: IsolatedEnv) {
  const registry = createProcessRegistry();
  onCleanup(() => {
    registry.killAllSync();
  });
  return createGit({ registry, env: env.env });
}

describe("recovery after a hard kill", () => {
  it("kills the orphaned session, commits its work as WIP and requeues its task to resume", async () => {
    const repo = await createTempRepo({ files: { "src/app.ts": "export const answer = 41;\n" } });
    const env = await isolatedEnv();
    const marker = `tool-${randomUUID()}`;
    await env.writeScenario({
      turns: [
        {
          steps: [
            { kind: "write", path: "src/half.ts", content: "export const half = true;\n" },
            { kind: "spawnGrandchild", marker },
            { kind: "text", text: "Still working" },
            { kind: "hang" },
          ],
        },
      ],
    });
    const dbPath = join(env.root, "db.sqlite");
    const worktreeDir = join(env.worktreeRoot, "demo");
    const db = openTestDb(dbPath);
    db.tasks.create({
      id: "half",
      title: "Half",
      goal: "Do half.",
      acceptance: "true",
      touches: ["src/"],
    });

    const previousRun = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        previousRunScript,
        JSON.stringify({
          repoRoot: repo.path,
          homeDir: env.home,
          dbPath,
          worktreeDir,
          promptsDir,
          taskId: "half",
        }),
      ],
      { cwd: workspaceRoot, env: env.env, stdio: ["ignore", "ignore", "inherit"] },
    );
    trackChild(previousRun);
    const session = await waitFor(() => {
      const [started] = db.sessions.listForTask("half");
      const events = started === undefined ? [] : db.events.listForSession(started.id);
      return events.some((event) => event.summary === "Still working") && started;
    }, 15_000);
    previousRun.kill("SIGKILL");
    await once(previousRun, "exit");
    expect(env.livePids()).not.toEqual([]);
    expect(findPids(marker)).not.toEqual([]);

    const checking = db.tasks.create({
      id: "checked",
      title: "Checked",
      goal: "Be checked.",
      acceptance: "true",
      touches: ["docs/"],
      status: "checking",
    });
    const check = db.checks.create({ taskId: checking.id, round: 1, kind: "build" });
    const rebase = db.rebases.create({ taskId: checking.id });

    const recoveryGit = gitFor(env);
    const report = await recoverPreviousRun({ db, git: recoveryGit });

    await waitFor(() => env.livePids().length === 0 && findPids(marker).length === 0);
    expect(db.sessions.get(session.id)).toMatchObject({ status: "killed" });
    expect(db.tasks.get("half")).toMatchObject({
      status: "pending",
      attempts: 0,
      resumeSession: session.claudeSessionId,
    });
    expect(db.tasks.get("checked")?.status).toBe("checking");
    expect(db.checks.get(check.id)?.status).toBe("killed");
    expect(db.rebases.listForTask(checking.id)).toEqual([{ ...rebase, status: "killed" }]);

    const clone = join(worktreeDir, "half");
    const git = (...args: string[]) => recoveryGit.run(clone, args);
    expect((await git("log", "-1", "--format=%B")).trim()).toBe(interruptedMessage);
    expect((await git("log", "-1", "--format=%(trailers)")).trim()).toBe("");
    expect(await git("show", "--name-only", "--format=", "HEAD")).toContain("src/half.ts");
    expect(await git("status", "--porcelain")).toBe("");
    expect(report).toEqual({
      reaped: [session.id],
      saved: [{ taskId: "half", commit: (await git("rev-parse", "HEAD")).trim() }],
      requeued: [{ taskId: "half", resumeSession: session.claudeSessionId }],
      killed: { sessions: 1, checks: 1, rebases: 1 },
      failures: [],
    });
  });

  it("leaves an unrelated process that reuses a recorded pid alone and still requeues the task", async () => {
    const env = await isolatedEnv();
    const db = openTestDb(join(await makeTempDir("recovery"), "db.sqlite"));
    const pid = await startUnrelatedProcess();
    db.tasks.create({
      id: "reused",
      title: "Reused",
      goal: "Survive a pid reuse.",
      acceptance: "true",
      touches: ["src/"],
      status: "running",
    });
    db.tasks.update("reused", { attempts: 2 });
    const session = db.sessions.create({
      role: "worker",
      taskId: "reused",
      attempt: 3,
      claudeSessionId: randomUUID(),
      pid,
      pgid: pid,
    });

    const report = await recoverPreviousRun({ db, git: gitFor(env) });

    expect(isAlive(pid)).toBe(true);
    expect(report.reaped).toEqual([]);
    expect(db.sessions.get(session.id)?.status).toBe("killed");
    expect(db.tasks.get("reused")).toMatchObject({
      status: "pending",
      attempts: 2,
      resumeSession: null,
    });
  });
});
