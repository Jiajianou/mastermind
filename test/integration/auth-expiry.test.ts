import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BusEvent, Session } from "@mastermind/core/contracts";
import type { Db } from "@mastermind/core/db";
import { createNativeNotifier } from "@mastermind/core/notify";
import { createProcessRegistry } from "@mastermind/core/procs";
import { createRuntime } from "@mastermind/core/runtime";
import type { Runtime } from "@mastermind/core/runtime";
import { signInFreshForMs } from "@mastermind/core/sign-in";
import { startMastermind } from "@mastermind/core/startup";
import { describe, expect, it } from "vitest";
import { onCleanup } from "../support/cleanup.js";
import type { Scenario } from "../support/fake-claude.js";
import { isolatedEnv } from "../support/isolated-env.js";
import type { IsolatedEnv } from "../support/isolated-env.js";
import { waitFor } from "../support/processes.js";
import { createTempRepo } from "../support/temp-repo.js";
import { scriptedPrompts } from "./startup/scripted-prompts.js";

const promptsDir = fileURLToPath(new URL("../../prompts/", import.meta.url));
const signInLine = "Sign-in needed: finish it in the terminal running mastermind";

interface Running {
  runtime: Runtime;
  db: Db;
  env: IsolatedEnv;
  events: BusEvent[];
  advanceClock(ms: number): void;
}

async function runMastermind(scenario: Scenario): Promise<Running> {
  const repo = await createTempRepo({
    files: { "README.md": "# Demo\n", "mastermind.yaml": "reviewer: { enabled: false }\n" },
  });
  await repo.git("switch", "--quiet", "--create", "dev");
  const env = await isolatedEnv();
  await env.writeScenario(scenario);
  const registry = createProcessRegistry();
  let offsetMs = 0;
  const clock = { now: () => new Date(Date.now() + offsetMs) };
  const errors: unknown[] = [];
  const startup = await startMastermind({
    path: repo.path,
    env: env.env,
    homeDir: env.home,
    platform: process.platform,
    registry,
    prompts: scriptedPrompts([]).prompts,
  });
  const runtime = await createRuntime({
    startup,
    registry,
    env: env.env,
    homeDir: env.home,
    promptsDir,
    webRoot: join(env.root, "no-web"),
    pathGuardCommand: ["node", "/opt/mastermind/path-guard.js"],
    nativeNotifier: createNativeNotifier({ registry, env: env.env, platform: process.platform }),
    onError: (error) => errors.push(error),
    clock,
  });
  onCleanup(() => {
    runtime.killProcessesSync();
    runtime.closeSync();
    if (errors.length > 0) throw new AggregateError(errors, "mastermind reported errors");
  });
  const events: BusEvent[] = [];
  runtime.bus.subscribe((event) => events.push(event));
  await runtime.actions.invoke("createTasks", {
    tasks: [
      {
        id: "lexer",
        title: "Lexer",
        goal: "Write the lexer.",
        acceptance: "true",
        touches: ["src/"],
      },
    ],
  });
  return {
    runtime,
    db: startup.db,
    env,
    events,
    advanceClock: (ms) => {
      offsetMs += ms;
    },
  };
}

async function signOutOfFakeClaude(env: IsolatedEnv): Promise<void> {
  const stateDir = env.env.FAKE_CLAUDE_STATE ?? "";
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "auth.json"), JSON.stringify({ account: "signed-out" }));
}

const workers = ({ db }: Running): Session[] =>
  db.sessions.listForTask("lexer").filter((session) => session.role === "worker");

const signInMessages = ({ db }: Running): string[] =>
  db.chat.list().flatMap((message) => (message.content === signInLine ? [message.content] : []));

async function resumeArgs(env: IsolatedEnv): Promise<boolean[]> {
  return (await env.invocations())
    .filter(({ argv }) => argv.includes("-p") && !argv.includes("--mcp-config"))
    .map(({ argv }) => argv.includes("--resume"));
}

describe("sign-in expiry while running", () => {
  it("requeues a session that failed on sign-in without an attempt, pauses until a login, then resumes the work", async () => {
    const running = await runMastermind({
      turns: [
        {
          match: { role: "worker", flags: ["--resume"] },
          steps: [{ kind: "text", text: "Done." }],
        },
        {
          match: { role: "worker" },
          steps: [
            { kind: "text", text: "Working on the lexer." },
            { kind: "authExpired", signOut: true },
          ],
        },
      ],
    });
    const { runtime, db, env, events } = running;

    runtime.start();
    await waitFor(() => db.flags.get().authRequired, 15_000);

    expect(db.flags.get()).toMatchObject({ authRequired: true, paused: true });
    expect(runtime.scheduler.summary()).toMatchObject({ paused: true, authRequired: true });
    expect(workers(running).map(({ status }) => status)).toEqual(["auth_failed"]);
    expect(db.tasks.get("lexer")).toMatchObject({ status: "pending", attempts: 0 });
    expect(events).toContainEqual({ type: "auth.updated", authRequired: true });
    expect(signInMessages(running)).toEqual([signInLine]);
    await waitFor(async () =>
      (await env.notifications()).some(({ args }) => args.includes(signInLine)),
    );

    const verdict = await runtime.signIn();

    expect(verdict).toMatchObject({ kind: "accepted", plan: "max" });
    expect(db.flags.get()).toMatchObject({ authRequired: false, paused: false });
    expect(events).toContainEqual({ type: "auth.updated", authRequired: false });
    await waitFor(() => workers(running)[1]?.status === "succeeded", 15_000);
    expect(db.tasks.get("lexer")?.attempts).toBe(0);
    expect(await resumeArgs(env)).toEqual([false, true]);
    expect(
      (await env.invocations()).filter(({ argv }) => argv.join(" ") === "auth login --claudeai"),
    ).toHaveLength(1);
  });

  it("checks the sign-in before starting a session when the last check is over 5 minutes old, and starts nothing while signed out", async () => {
    const running = await runMastermind({ turns: [{ steps: [{ kind: "text", text: "Done." }] }] });
    const { runtime, db, env } = running;
    await runtime.actions.invoke("hold", { taskId: "lexer" });
    runtime.start();
    await signOutOfFakeClaude(env);
    running.advanceClock(signInFreshForMs + 60_000);

    await runtime.actions.invoke("release", { taskId: "lexer" });
    await waitFor(() => db.flags.get().authRequired, 15_000);

    expect(db.flags.get()).toMatchObject({ authRequired: true, paused: true });
    expect(workers(running)).toEqual([]);
    expect(db.tasks.get("lexer")).toMatchObject({ status: "pending", attempts: 0 });
    expect(signInMessages(running)).toEqual([signInLine]);

    await runtime.signIn();

    await waitFor(() => workers(running)[0]?.status === "succeeded", 15_000);
    expect(db.flags.get()).toMatchObject({ authRequired: false, paused: false });
  });
});
