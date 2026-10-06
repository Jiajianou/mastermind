import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Step } from "../support/fake-claude.js";
import { isolatedEnv } from "../support/isolated-env.js";
import { conductorToolCalls, openProjectDb, startMastermind } from "../support/mastermind.js";
import { waitFor } from "../support/processes.js";
import { createTempRepo } from "../support/temp-repo.js";

const write = (path: string): Step => ({ kind: "write", path, content: `${path}\n` });

// The Conductor is the first session and greeting's worker the second; the test checks that before steering.
const workerSessionId = 2;

describe("milestone 4: steering a live worker from the chat", () => {
  it("a message sent through the chat reaches the running worker's stdin and changes what it writes", async () => {
    const repo = await createTempRepo({ files: { "README.md": "# Demo\n" } });
    await repo.git("switch", "--quiet", "--create", "dev");
    const env = await isolatedEnv();
    await env.writeScenario({
      turns: [
        {
          match: { role: "conductor", prompt: "add a greeting" },
          steps: [
            {
              kind: "mcp",
              tool: "create_tasks",
              arguments: {
                tasks: [
                  {
                    id: "greeting",
                    title: "Add a greeting",
                    goal: "Add greeting.txt.",
                    acceptance: "test -f greeting.txt",
                    touches: ["greeting.txt", "greeting.test.txt"],
                  },
                ],
              },
            },
            { kind: "text", text: "I added greeting." },
          ],
        },
        {
          match: { role: "conductor", prompt: "tests first" },
          steps: [
            {
              kind: "mcp",
              tool: "message_session",
              arguments: { sessionId: workerSessionId, text: "Write the tests first." },
            },
            { kind: "text", text: "I told the greeting worker." },
          ],
        },
        {
          match: { role: "worker" },
          steps: [
            { kind: "text", text: "Waiting for direction." },
            {
              kind: "awaitMessage",
              branches: [{ when: "tests first", steps: [write("greeting.test.txt")] }],
              otherwise: [write("greeting.txt")],
            },
            { kind: "text", text: "Next step chosen." },
            { kind: "hang" },
          ],
        },
      ],
    });
    const running = await startMastermind(repo, env.env);
    const db = openProjectDb(repo);

    const added = await running.run(["chat", "add a greeting task"]);
    expect(added).toMatchObject({ code: 0, stdout: "I added greeting.\n✓ Added 1 task\n" });
    const worker = await waitFor(() => {
      const session = db.sessions.get(workerSessionId);
      return (
        session?.status === "running" &&
        db.events
          .listForSession(workerSessionId)
          .some((event) => event.summary === "Waiting for direction.") &&
        session
      );
    }, 15_000);
    expect(worker).toMatchObject({ role: "worker", taskId: "greeting" });

    const steered = await running.run(["chat", "tell the greeting worker to write tests first"]);
    expect(steered).toMatchObject({
      code: 0,
      stderr: "",
      stdout: "I told the greeting worker.\n✓ Sent to greeting\n",
    });

    const events = await waitFor(() => {
      const stored = db.events.listForSession(workerSessionId);
      return stored.some((event) => event.summary === "Next step chosen.") && stored;
    }, 10_000);
    expect(events.filter((event) => event.type === "steer").map((event) => event.summary)).toEqual([
      "Write the tests first.",
    ]);
    const clone = db.tasks.get("greeting")?.worktree;
    if (clone === null || clone === undefined) throw new Error("greeting has no clone");
    expect(existsSync(join(clone, "greeting.test.txt"))).toBe(true);
    expect(existsSync(join(clone, "greeting.txt"))).toBe(false);

    expect(db.sessions.get(workerSessionId)?.status).toBe("running");
    expect(db.sessions.listForTask("greeting")).toHaveLength(1);
    const received = (await env.readLog()).flatMap((record) =>
      record.kind === "message" && record.pid === worker.pid ? [record.text] : [],
    );
    expect(received).toEqual([
      expect.stringContaining("# Task greeting"),
      "Write the tests first.",
    ]);
    expect(conductorToolCalls(db)).toEqual([
      "mcp__mastermind__create_tasks",
      "mcp__mastermind__message_session",
    ]);
  });
});
