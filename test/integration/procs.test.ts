import { randomUUID } from "node:crypto";
import { createClaudeCli } from "@mastermind/core/claude";
import { createProcessRegistry, SpawnError, stopGroup } from "@mastermind/core/procs";
import type { ChildHandle, ProcessRegistry } from "@mastermind/core/procs";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Step } from "../support/fake-claude.js";
import { isolatedEnv } from "../support/isolated-env.js";
import type { IsolatedEnv } from "../support/isolated-env.js";
import { isAlive, processTable, waitFor } from "../support/processes.js";

function registryForTest(): ProcessRegistry {
  const registry = createProcessRegistry();
  onTestFinished(() => {
    registry.killAllSync();
  });
  return registry;
}

async function startHangingSession(
  env: IsolatedEnv,
  registry: ProcessRegistry,
  options: { grandchild?: boolean; ignoreSigterm?: boolean } = {},
): Promise<ChildHandle> {
  const steps: Step[] = [
    ...(options.grandchild === true ? [{ kind: "spawnGrandchild" } as const] : []),
    { kind: "text", text: "ready" },
    { kind: "hang", ignoreSigterm: options.ignoreSigterm },
  ];
  await env.writeScenario({ turns: [{ steps }] });
  const lines: string[] = [];
  const cli = createClaudeCli({ registry, env: env.env });
  const session = await cli.spawn(
    "session",
    { command: "print", options: { model: "haiku", inputFormat: "stream-json" } },
    { cwd: env.root, io: { stdin: "pipe", onStdoutLine: (line) => lines.push(line) } },
  );
  session.stdin?.write(
    `${JSON.stringify({ type: "user", message: { role: "user", content: "go" } })}\n`,
  );
  await waitFor(() => lines.some((line) => line.includes('"text":"ready"')));
  return session;
}

const livingMembers = (pgids: readonly number[]) =>
  processTable().filter((row) => pgids.includes(row.pgid));

describe("process registry", () => {
  it("killAllSync leaves nothing of a session, its grandchild in another group, or a check", async () => {
    const env = await isolatedEnv();
    const registry = registryForTest();
    const session = await startHangingSession(env, registry, { grandchild: true });
    const check = await registry.spawn({
      kind: "check",
      command: "/bin/sh",
      args: ["-c", "sleep 300 & sleep 300; wait"],
      env: env.env,
      io: { stdin: "ignore" },
    });
    const grandchild = (await env.readLog()).find((record) => record.kind === "spawn");
    if (grandchild?.kind !== "spawn") throw new Error("fake-claude logged no grandchild");
    const groups = [session.pgid, check.pgid, grandchild.childPgid];
    expect(new Set(groups).size).toBe(3);
    await waitFor(() => livingMembers([check.pgid]).length === 3);
    expect(isAlive(grandchild.childPid)).toBe(true);

    const report = registry.killAllSync();

    expect(report).toEqual({
      counts: { session: 1, check: 1, rebase: 0, conductor: 0, terminal: 0, utility: 0 },
      failures: [],
    });
    expect(registry.tracked()).toEqual([]);
    await waitFor(() => livingMembers(groups).length === 0, 2_000);
    expect(await session.exited).toEqual({ kind: "signaled", signal: "SIGKILL" });
    expect(await check.exited).toEqual({ kind: "signaled", signal: "SIGKILL" });
  });

  it.each([
    { behaviour: "honours SIGTERM", ignoreSigterm: false, exit: { kind: "exited", code: 143 } },
    {
      behaviour: "ignores SIGTERM",
      ignoreSigterm: true,
      exit: { kind: "signaled", signal: "SIGKILL" },
    },
  ])("stopGroup ends a session that $behaviour", async ({ ignoreSigterm, exit }) => {
    const env = await isolatedEnv();
    const registry = registryForTest();
    const graceMs = 1_000;
    const session = await startHangingSession(env, registry, { ignoreSigterm });
    const started = Date.now();

    const result = await stopGroup(session, { graceMs });

    const elapsed = Date.now() - started;
    expect(result).toEqual(exit);
    expect(elapsed).toBeGreaterThanOrEqual(ignoreSigterm ? graceMs : 0);
    expect(livingMembers([session.pgid])).toEqual([]);
    expect(registry.tracked()).toEqual([]);
    const signals = (await env.readLog()).filter((record) => record.kind === "signal");
    expect(signals).toEqual([
      expect.objectContaining({ signal: "SIGTERM", ignored: ignoreSigterm }),
    ]);
  });

  it("delivers stdout and stderr line by line, including a last line without a newline", async () => {
    const registry = registryForTest();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const marker = randomUUID();

    const child = await registry.spawn({
      kind: "check",
      command: "/bin/sh",
      args: ["-c", `printf 'one\\ntwo\\n'; printf 'warn\\n' >&2; printf '${marker}'; exit 3`],
      env: { PATH: process.env.PATH ?? "" },
      io: {
        stdin: "ignore",
        onStdoutLine: (line) => stdout.push(line),
        onStderrLine: (line) => stderr.push(line),
      },
    });

    expect(registry.tracked()).toEqual([{ kind: "check", pid: child.pid, pgid: child.pid }]);
    expect(await child.exited).toEqual({ kind: "exited", code: 3 });
    expect(stdout).toEqual(["one", "two", marker]);
    expect(stderr).toEqual(["warn"]);
    expect(registry.tracked()).toEqual([]);
  });

  it("fails with a SpawnError and tracks nothing when the command does not exist", async () => {
    const registry = registryForTest();

    const spawning = registry.spawn({
      kind: "check",
      command: "mastermind-no-such-command",
      args: [],
      env: { PATH: "/nonexistent" },
      io: { stdin: "ignore" },
    });

    await expect(spawning).rejects.toBeInstanceOf(SpawnError);
    expect(registry.tracked()).toEqual([]);
  });
});
