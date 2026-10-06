import { conductorRolloverTokens } from "@mastermind/core/conductor";
import { chatTurnSchema } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import type { Scenario, Step } from "../../support/fake-claude.js";
import { waitFor } from "../../support/processes.js";
import { conductorHarness } from "./harness.js";
import type { ConductorHarness } from "./harness.js";

const summary = "The owner wants a lexer first, then a parser; they prefer small tasks.";

const reply = (prompt: string, text: string, contextTokens: number) => ({
  match: { role: "conductor", prompt },
  steps: [{ kind: "text", text, contextTokens } satisfies Step],
});

function scenario(judge: Step): Scenario {
  return {
    turns: [
      { match: { flags: ["--json-schema"] }, steps: [judge] },
      reply("plan the lexer", "I'll keep the lexer small.", 40_000),
      reply(
        "then the parser",
        "The parser comes after the lexer.",
        conductorRolloverTokens + 20_000,
      ),
      reply("what was my plan", "Lexer first, then the parser.", 12_000),
    ],
  };
}

async function chat(harness: ConductorHarness, text: string): Promise<void> {
  const { turnId } = chatTurnSchema.parse(await harness.post("/api/chat", { text }));
  await harness.waitForTurnEnd(turnId);
}

async function conductorRuns(harness: ConductorHarness) {
  const invocations = await harness.env.invocations();
  return invocations.flatMap(({ argv }) => {
    if (!argv.includes("--mcp-config")) return [];
    const flag = argv.includes("--resume") ? "--resume" : "--session-id";
    return [{ flag, id: argv[argv.indexOf(flag) + 1] }];
  });
}

async function prompts(harness: ConductorHarness): Promise<string[]> {
  return (await harness.env.readLog()).flatMap((record) =>
    record.kind === "message" ? [record.text] : [],
  );
}

const judgeSessions = (harness: ConductorHarness) =>
  harness.db.sessions.list().filter((session) => session.role === "judge");

describe("Conductor rollover", () => {
  it("summarises a conversation whose context passed the threshold and continues the chat in a new one from the summary", async () => {
    const harness = await conductorHarness({
      scenario: scenario({ kind: "structuredOutput", output: { summary } }),
    });

    await chat(harness, "plan the lexer");
    const first = harness.db.conductorSessions.current();
    expect(first?.tokens).toBe(40_000);
    await chat(harness, "then the parser");
    await waitFor(() => harness.db.conductorSessions.latestSummary() === summary);
    await chat(harness, "what was my plan");

    const runs = await conductorRuns(harness);
    expect(runs.map(({ flag }) => flag)).toEqual(["--session-id", "--session-id"]);
    expect(runs[0]?.id).toBe(first?.id);
    const second = harness.db.conductorSessions.current();
    expect(second).toMatchObject({ id: runs[1]?.id, endedAt: null, tokens: 12_000 });

    const received = await prompts(harness);
    const judgePrompt = received.find((text) => text.includes("The chat:"));
    expect(judgePrompt).toContain("Owner: plan the lexer");
    expect(judgePrompt).toContain("Mastermind: The parser comes after the lexer.");
    const resumed = received.find((text) => text.endsWith("what was my plan"));
    expect(resumed?.startsWith(`<summary>\n${summary}\n</summary>\n<state>\n`)).toBe(true);
    expect(received.filter((text) => text.startsWith("<summary>"))).toHaveLength(1);
    expect(judgeSessions(harness)).toMatchObject([
      { taskId: null, model: "haiku", status: "succeeded" },
    ]);

    const messages = harness.messages();
    expect(messages.map(({ kind, content }) => `${kind}: ${content}`)).toEqual([
      "user: plan the lexer",
      "conductor: I'll keep the lexer small.",
      "user: then the parser",
      "conductor: The parser comes after the lexer.",
      "user: what was my plan",
      "conductor: Lexer first, then the parser.",
    ]);
    expect(messages.at(-1)?.conductorSession).toBe(second?.id);
  });

  it("keeps the conversation when the summary can't be made", async () => {
    const harness = await conductorHarness({
      scenario: scenario({ kind: "crash", stderr: "judge crashed" }),
    });

    await chat(harness, "plan the lexer");
    await chat(harness, "then the parser");
    await waitFor(() => judgeSessions(harness).some(({ status }) => status !== "running"));
    await chat(harness, "what was my plan");

    const runs = await conductorRuns(harness);
    expect(runs.map(({ flag }) => flag)).toEqual(["--session-id"]);
    expect(harness.messages().at(-1)?.content).toBe("Lexer first, then the parser.");
    expect(harness.db.conductorSessions.latestSummary()).toBeNull();
    expect(harness.db.conductorSessions.current()).toMatchObject({
      id: runs[0]?.id,
      endedAt: null,
    });
    expect((await prompts(harness)).some((text) => text.startsWith("<summary>"))).toBe(false);
    expect(judgeSessions(harness)).toHaveLength(1);
  });
});
