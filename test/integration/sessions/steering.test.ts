import { existsSync } from "node:fs";
import { join } from "node:path";
import { chatTurnSchema, messageSessionResultSchema } from "@mastermind/core/contracts";
import type { MessageSessionResult } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import type { Step } from "../../support/fake-claude.js";
import { waitFor } from "../../support/processes.js";
import { conductorHarness } from "../conductor/harness.js";
import { sessionHarness } from "./harness.js";
import type { SessionHarness } from "./harness.js";

const write = (path: string): Step => ({ kind: "write", path, content: `${path}\n` });

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function finishedRun(harness: SessionHarness, taskId: string) {
  await harness.manager.startTask(harness.addTask(taskId));
  await harness.waitForStatus(taskId, "checking");
  const [session] = harness.db.sessions.listForTask(taskId);
  if (session === undefined) throw new Error(`no session for ${taskId}`);
  return session;
}

describe("steering sessions", () => {
  it("writes a message into a live worker's stdin, which changes what it does next", async () => {
    const harness = await sessionHarness({
      scenario: {
        turns: [
          {
            match: { role: "worker" },
            steps: [
              { kind: "text", text: "Waiting for direction." },
              {
                kind: "awaitMessage",
                branches: [{ when: "tests first", steps: [write("src/app.test.ts")] }],
                otherwise: [write("src/plan.md")],
              },
              { kind: "text", text: "Done." },
            ],
          },
        ],
      },
    });
    await harness.manager.startTask(harness.addTask("app"));
    const session = await waitFor(() => {
      const [running] = harness.db.sessions.listForTask("app");
      return (
        running !== undefined &&
        harness.db.events
          .listForSession(running.id)
          .some((event) => event.summary === "Waiting for direction.") &&
        running
      );
    });

    const result = await harness.manager.messageSession(session.id, "Write the tests first.");
    await harness.waitForStatus("app", "checking");

    expect(result).toMatchObject({ delivery: "live", session: { id: session.id } });
    const clone = join(harness.config.worktreeDir, "app");
    expect(existsSync(join(clone, "src/app.test.ts"))).toBe(true);
    expect(existsSync(join(clone, "src/plan.md"))).toBe(false);
    const steers = harness.db.events
      .listForSession(session.id)
      .filter((event) => event.type === "steer");
    expect(steers.map((event) => event.summary)).toEqual(["Write the tests first."]);
    expect(harness.db.sessions.listForTask("app")).toHaveLength(1);
    expect(harness.errors).toEqual([]);
  });

  it("resumes an ended session with the message in the same clone, as a new session that counts no attempt", async () => {
    const harness = await sessionHarness({
      scenario: {
        turns: [
          {
            match: { role: "worker", flags: ["--resume"], prompt: "changelog" },
            steps: [write("CHANGELOG.md"), { kind: "text", text: "Added the changelog." }],
          },
          {
            match: { role: "worker" },
            steps: [write("src/feature.ts"), { kind: "text", text: "Done." }],
          },
        ],
      },
    });
    const first = await finishedRun(harness, "feature");

    const result = await harness.manager.messageSession(first.id, "Add a changelog too.");
    const resumed = await waitFor(() => {
      const session = harness.db.sessions.get(result.session.id);
      return session?.status === "succeeded" && session;
    });
    const task = await harness.waitForStatus("feature", "checking");

    expect(result.delivery).toBe("resumed");
    expect(resumed).toMatchObject({
      role: "worker",
      taskId: "feature",
      attempt: first.attempt,
      round: first.round,
      claudeSessionId: first.claudeSessionId,
    });
    expect(resumed.id).not.toBe(first.id);
    expect(task.attempts).toBe(0);
    expect(await harness.cloneGit("feature", "ls-files", "CHANGELOG.md")).toBe("CHANGELOG.md");

    const invocation = (await harness.env.invocations()).find(({ pid }) => pid === resumed.pid);
    expect(flagValue(invocation?.argv ?? [], "--resume")).toBe(first.claudeSessionId);
    expect(invocation?.argv).not.toContain("--session-id");
    expect(invocation?.cwd).toBe(task.worktree);
    const received = (await harness.env.readLog()).flatMap((record) =>
      record.kind === "message" && record.pid === resumed.pid ? [record.text] : [],
    );
    expect(received).toEqual(["Add a changelog too."]);
    const [steer] = harness.db.events.listForSession(resumed.id);
    expect(steer).toMatchObject({ type: "steer", summary: "Add a changelog too." });
    expect(harness.errors).toEqual([]);
  });

  it("redelivers a message the worker never took in by resuming, and records why when that is refused", async () => {
    const harness = await sessionHarness({
      scenario: {
        turns: [
          {
            match: { role: "worker" },
            steps: [
              { kind: "text", text: "Working." },
              { kind: "crash", exitCode: 1, afterMs: 1_500 },
            ],
          },
        ],
      },
    });
    await harness.manager.startTask(harness.addTask("flaky"));
    const session = await waitFor(() => {
      const [running] = harness.db.sessions.listForTask("flaky");
      return (
        running !== undefined &&
        harness.db.events
          .listForSession(running.id)
          .some(({ summary }) => summary === "Working.") &&
        running
      );
    });

    const result = await harness.manager.messageSession(session.id, "Use the new API.");
    const undelivered = await waitFor(() =>
      harness.db.events
        .listForSession(session.id)
        .find(({ summary }) => summary.startsWith("Message not delivered")),
    );

    expect(result.delivery).toBe("live");
    expect(undelivered.type).toBe("error");
    expect(undelivered.summary).toContain("backing off after a usage limit");
    expect(harness.db.sessions.listForTask("flaky")).toHaveLength(1);
    expect(harness.db.events.listForSession(session.id).map(({ type }) => type)).not.toContain(
      "steer",
    );
    expect(harness.errors).toEqual([]);
  });

  it("refuses messages it can't deliver and starts nothing", async () => {
    const harness = await sessionHarness({ scenario: { turns: [{ steps: [write("src/x.ts")] }] } });
    const ended = await finishedRun(harness, "blocked-task");
    harness.db.tasks.update("blocked-task", { status: "blocked" });
    const conductor = harness.db.sessions.create({ role: "conductor" });

    await expect(harness.manager.messageSession(ended.id, "Try again.")).rejects.toThrow(
      "blocked-task is blocked; retry it first",
    );
    await expect(harness.manager.messageSession(conductor.id, "Hello.")).rejects.toThrow(
      "only worker and fixer sessions take messages",
    );
    await expect(harness.manager.messageSession(999, "Hello.")).rejects.toThrow("no session 999");
    expect(harness.db.sessions.listForTask("blocked-task")).toHaveLength(1);
    expect(harness.db.tasks.get("blocked-task")?.status).toBe("blocked");
  });

  it("reaches the manager from the chat's message_session tool and the HTTP route, and the action line names the task", async () => {
    const calls: { sessionId: number; text: string }[] = [];
    const harness = await conductorHarness({
      scenario: {
        turns: [
          {
            match: { role: "conductor", prompt: "tell the parser" },
            steps: [
              {
                kind: "mcp",
                tool: "message_session",
                arguments: { sessionId: 1, text: "Use the new token type." },
              },
              { kind: "text", text: "Told it." },
            ],
          },
        ],
      },
      messageSession: (sessionId, text): Promise<MessageSessionResult> => {
        calls.push({ sessionId, text });
        const session = harness.db.sessions.get(sessionId);
        if (session === null) return Promise.reject(new Error("unknown session"));
        return Promise.resolve({ delivery: "live", session });
      },
    });
    harness.db.sessions.create({ role: "worker", taskId: "parser", attempt: 1 });

    const { turnId } = chatTurnSchema.parse(
      await harness.post("/api/chat", { text: "tell the parser to use the new token type" }),
    );
    const turn = await harness.waitForTurnEnd(turnId);
    const routed = messageSessionResultSchema.parse(
      await harness.post("/api/sessions/1/message", { text: "  Also add tests.\n" }),
    );

    expect(turn.at(-1)).toMatchObject({ kind: "action", content: "✓ Sent to parser" });
    expect(routed).toMatchObject({ delivery: "live", session: { id: 1, taskId: "parser" } });
    expect(calls).toEqual([
      { sessionId: 1, text: "Use the new token type." },
      { sessionId: 1, text: "Also add tests." },
    ]);
  });
});
