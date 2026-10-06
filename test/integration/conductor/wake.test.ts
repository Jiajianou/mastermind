import type { TaskStatus } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { waitFor } from "../../support/processes.js";
import { conductorHarness } from "./harness.js";
import type { ConductorHarness } from "./harness.js";

const task = (id: string) => ({
  id,
  title: `Build ${id}`,
  goal: `Make ${id} work.`,
  acceptance: "true",
  touches: [`src/${id}/`],
});

function moveTask(harness: ConductorHarness, taskId: string, statuses: readonly TaskStatus[]) {
  for (const status of statuses) {
    const moved = harness.db.tasks.update(taskId, { status });
    harness.bus.emit({ type: "task.updated", taskId, task: moved });
  }
}

const wakeReply = "lexer and parser are blocked and need your call.";

describe("conductor.wakeOnEvents", () => {
  it("gives the chat one turn of its own for the listed event lines posted together, and none for others", async () => {
    const harness = await conductorHarness({
      config: { conductor: { wakeOnEvents: ["blocked"] } },
      scenario: {
        turns: [{ match: { role: "conductor" }, steps: [{ kind: "text", text: wakeReply }] }],
      },
    });
    await harness.post("/api/tasks", { tasks: [task("lexer"), task("parser"), task("docs")] });

    moveTask(harness, "docs", ["running", "checking", "review"]);
    // A wake starts its turn on the next macrotask, so after one the chat would already be replying.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.runner.status().replying).toBe(false);
    moveTask(harness, "lexer", ["running", "blocked"]);
    moveTask(harness, "parser", ["running", "blocked"]);
    await waitFor(() => harness.messages().some((message) => message.kind === "conductor"));
    await waitFor(() => !harness.runner.status().replying);

    const received = (await harness.env.readLog()).flatMap((record) =>
      record.kind === "message" ? [record.text] : [],
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toMatch(
      /<updates>\n.*docs is ready for review\n.*lexer is blocked\n.*parser is blocked\n<\/updates>\n\n<wake\/>$/,
    );
    expect(harness.messages().map(({ kind, content }) => `${kind}: ${content}`)).toEqual([
      "system: docs is ready for review",
      "system: lexer is blocked",
      "system: parser is blocked",
      `conductor: ${wakeReply}`,
    ]);
  });
});
