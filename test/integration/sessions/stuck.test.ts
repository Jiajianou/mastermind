import { chatMessageSchema } from "@mastermind/core/contracts";
import type { Session } from "@mastermind/core/contracts";
import { createStuckMonitor, stuckWipMessage } from "@mastermind/core/sessions";
import { describe, expect, it } from "vitest";
import { onCleanup } from "../../support/cleanup.js";
import type { Scenario, Step } from "../../support/fake-claude.js";
import { waitFor } from "../../support/processes.js";
import { sessionHarness } from "./harness.js";
import type { SessionHarness } from "./harness.js";

const minute = 60_000;
const reason = "looping on make test";
const suggestion = "read the failing test before changing the lexer";

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function judgeTurn(verdict: { stuck: boolean; reason: string; suggestion: string }) {
  return {
    match: { flags: ["--json-schema"] },
    steps: [{ kind: "structuredOutput", output: verdict }] satisfies Step[],
  };
}

async function harnessWithClock(scenario: Scenario) {
  let offsetMs = 0;
  const clock = { now: () => new Date(Date.now() + offsetMs) };
  const harness = await sessionHarness({ scenario, clock });
  const monitor = createStuckMonitor({
    db: harness.db,
    bus: harness.bus,
    clock,
    oneShot: harness.oneShot,
    sessions: harness.manager,
    config: () => harness.config,
    onError: (error) => harness.errors.push(error),
    pollMs: 20,
  });
  monitor.start();
  onCleanup(() => {
    monitor.stop();
  });
  return {
    harness,
    advanceClockTo: (ms: number) => {
      offsetMs = ms;
    },
  };
}

async function waitingWorker(harness: SessionHarness, taskId: string): Promise<Session> {
  await harness.manager.startTask(harness.addTask(taskId));
  return waitFor(() => {
    const [worker] = harness.db.sessions.listForTask(taskId);
    return (
      worker !== undefined &&
      harness.db.events.listForSession(worker.id).some((event) => event.summary === "Waiting.") &&
      worker
    );
  });
}

const checkNotesOf = (harness: SessionHarness, sessionId: number): string[] =>
  harness.db.events
    .listForSession(sessionId)
    .filter((event) => event.type === "note" && event.summary.startsWith("Checked at"))
    .map((event) => event.summary);

describe("stuck-session checks", () => {
  it("replaces a stuck session with a fresh one whose prompt carries the reason and suggestion", async () => {
    const { harness, advanceClockTo } = await harnessWithClock({
      turns: [
        {
          match: { role: "worker", prompt: "The previous attempt got stuck" },
          steps: [
            { kind: "write", path: "src/lexer.test.ts", content: "test('lexes', () => {});\n" },
            { kind: "text", text: "Done." },
          ],
        },
        {
          match: { role: "worker" },
          steps: [
            { kind: "write", path: "src/half.ts", content: "export const half = 1;\n" },
            { kind: "bash", command: "make test" },
            { kind: "bash", command: "make test" },
            { kind: "bash", command: "make test" },
            { kind: "text", text: "Waiting." },
            { kind: "hang" },
          ],
        },
        judgeTurn({ stuck: true, reason, suggestion }),
      ],
    });
    const stuck = await waitingWorker(harness, "lexer");

    advanceClockTo(61 * minute);
    const task = await harness.waitForStatus("lexer", "checking");

    const sessions = harness.db.sessions.listForTask("lexer");
    expect(sessions.map(({ role, attempt, status }) => ({ role, attempt, status }))).toEqual([
      { role: "worker", attempt: 1, status: "failed" },
      { role: "judge", attempt: null, status: "succeeded" },
      { role: "worker", attempt: 2, status: "succeeded" },
    ]);
    expect(task.attempts).toBe(1);
    expect(harness.db.events.listForSession(stuck.id).map((event) => event.summary)).toContain(
      `Session failed: stuck: ${reason}`,
    );

    const [first, fresh] = (await harness.env.invocations()).filter((invocation) =>
      invocation.argv.includes("--append-system-prompt-file"),
    );
    const freshSessionId = flagValue(fresh?.argv ?? [], "--session-id");
    expect(freshSessionId).toBeDefined();
    expect(freshSessionId).not.toBe(flagValue(first?.argv ?? [], "--session-id"));
    expect(fresh?.argv).not.toContain("--resume");
    const prompts = (await harness.env.readLog()).flatMap((record) =>
      record.kind === "message" && record.pid === fresh?.pid ? [record.text] : [],
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(
      `The previous attempt got stuck: ${reason}. Try a different approach: ${suggestion}.`,
    );
    expect(prompts[0]).toContain("Build lexer");
    expect(prompts[0]).toContain("+export const half = 1;");

    expect(await harness.cloneGit("lexer", "log", "--format=%s", "-2")).toBe(
      `WIP: uncommitted at session end\n${stuckWipMessage}`,
    );
    expect(await harness.cloneGit("lexer", "show", "--name-only", "--format=", "HEAD~1")).toBe(
      "src/half.ts",
    );

    const chatLines = harness.events.flatMap((event) =>
      event.type === "chat.message" ? [chatMessageSchema.parse(event.message)] : [],
    );
    expect(chatLines.map(({ kind, content, meta }) => ({ kind, content, meta }))).toEqual([
      {
        kind: "system",
        content: `lexer was stuck: ${reason}; restarted with a different approach`,
        meta: { event: "stuck", taskId: "lexer" },
      },
    ]);
  });

  it("notes a session that is still making progress and checks it again later", async () => {
    const { harness, advanceClockTo } = await harnessWithClock({
      turns: [
        {
          match: { role: "worker" },
          steps: [{ kind: "text", text: "Waiting." }, { kind: "hang" }],
        },
        judgeTurn({ stuck: false, reason: "steadily fixing tests", suggestion: "" }),
      ],
    });
    const worker = await waitingWorker(harness, "parser");

    advanceClockTo(61 * minute);
    await waitFor(() => checkNotesOf(harness, worker.id).length === 1);
    advanceClockTo(81 * minute);
    await waitFor(() => checkNotesOf(harness, worker.id).length === 2);

    expect(checkNotesOf(harness, worker.id)).toEqual([
      "Checked at 61 min: still making progress",
      "Checked at 81 min: still making progress",
    ]);
    expect(harness.db.sessions.get(worker.id)?.status).toBe("running");
    expect(harness.db.tasks.get("parser")).toMatchObject({ status: "running", attempts: 0 });
  });
});
