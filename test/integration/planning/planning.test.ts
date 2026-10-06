import { findGraphIssues } from "@mastermind/core/actions";
import { chatTurnSchema, planStartedMetaSchema, taskListSchema } from "@mastermind/core/contracts";
import type { ChatMessage } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import type { Scenario, Step } from "../../support/fake-claude.js";
import { conductorHarness } from "../conductor/harness.js";
import type { ConductorHarness } from "../conductor/harness.js";

const task = (id: string, deps: string[] = []) => ({
  id,
  title: `Build ${id}`,
  goal: `Make ${id} work.`,
  acceptance: `pnpm test ${id}`,
  touches: [`src/${id}/`],
  deps,
});

const parserPlan = [
  task("lexer"),
  task("ast"),
  { ...task("parser", ["lexer", "ast"]), note: "after the first two" },
];

const conductorTurn = (prompt: string, steps: Step[]): Scenario["turns"][number] => ({
  match: { role: "conductor", prompt },
  steps,
});

type PlannedTask = ReturnType<typeof task> & { note?: string };

const proposeTurn = (prompt: string, tasks: PlannedTask[]) =>
  conductorTurn(prompt, [
    { kind: "mcp", tool: "propose_plan", arguments: { tasks } },
    { kind: "text", text: "Here is the plan." },
  ]);

const fallbackTurn = conductorTurn("", [{ kind: "text", text: "Noted." }]);

async function chat(harness: ConductorHarness, text: string): Promise<ChatMessage[]> {
  const { turnId } = chatTurnSchema.parse(await harness.post("/api/chat", { text }));
  return harness.waitForTurnEnd(turnId);
}

function plans(harness: ConductorHarness): ChatMessage[] {
  return harness.messages().filter((message) => message.kind === "plan");
}

const graph = (harness: ConductorHarness) =>
  harness.db.tasks
    .list()
    .map(({ id, deps, status }) => ({ id, deps, status }))
    .sort((left, right) => left.id.localeCompare(right.id));

const parserGraph = [
  { id: "ast", deps: [], status: "pending" },
  { id: "lexer", deps: [], status: "pending" },
  { id: "parser", deps: ["ast", "lexer"], status: "pending" },
];

describe("planning through the chat", () => {
  it("shows a plan without creating anything, and Start creates all its tasks once", async () => {
    const harness = await conductorHarness({
      scenario: { turns: [proposeTurn("plan the parser", parserPlan), fallbackTurn] },
    });

    const turn = await chat(harness, "plan the parser");
    const [plan] = plans(harness);
    if (plan === undefined) throw new Error("no plan was shown");

    expect(turn.map((message) => message.kind)).toEqual(["user", "plan", "conductor"]);
    expect(plan.content).toBe(
      "1. lexer: Build lexer\n2. ast: Build ast\n3. parser: after the first two",
    );
    expect(harness.db.tasks.list()).toEqual([]);

    const started = taskListSchema.parse(await harness.post(`/api/plans/${String(plan.id)}/start`));

    expect(started.map((created) => created.id)).toEqual(["lexer", "ast", "parser"]);
    expect(graph(harness)).toEqual(parserGraph);
    expect(findGraphIssues(harness.db.tasks.list())).toEqual([]);
    const notice = harness.messages().at(-1);
    expect(notice).toMatchObject({
      kind: "system",
      content: "Plan started: added 3 tasks (lexer, ast, parser).",
    });
    expect(planStartedMetaSchema.parse(notice?.meta)).toEqual({ plan: "started", planId: plan.id });

    await expect(harness.post(`/api/plans/${String(plan.id)}/start`)).rejects.toThrow(
      `plan ${String(plan.id)} was already started`,
    );
    expect(harness.db.tasks.list()).toHaveLength(3);

    await chat(harness, "how is it going?");
    const prompts = (await harness.env.readLog()).flatMap((record) =>
      record.kind === "message" ? [record.text] : [],
    );
    expect(prompts.at(-1)).toContain("Plan started: added 3 tasks (lexer, ast, parser).");
  });

  it("starts the latest plan when the owner says go ahead, and refuses the plan it replaced", async () => {
    const harness = await conductorHarness({
      scenario: {
        turns: [
          proposeTurn("plan the parser", parserPlan.slice(0, 2)),
          proposeTurn("add the parser too", parserPlan),
          conductorTurn("go ahead", [
            { kind: "mcp", tool: "start_plan", arguments: {} },
            { kind: "text", text: "Started." },
          ]),
        ],
      },
    });

    await chat(harness, "plan the parser");
    await chat(harness, "add the parser too");
    const turn = await chat(harness, "go ahead");

    expect(turn.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: "user", content: "go ahead" },
      { kind: "conductor", content: "Started." },
      { kind: "action", content: "✓ Added 3 tasks" },
    ]);
    expect(graph(harness)).toEqual(parserGraph);

    const [replaced, latest] = plans(harness);
    await expect(harness.post(`/api/plans/${String(replaced?.id)}/start`)).rejects.toThrow(
      `plan ${String(replaced?.id)} was replaced by a newer plan (${String(latest?.id)})`,
    );
    expect(harness.db.tasks.list()).toHaveLength(3);
  });

  it("refuses to start a plan whose tasks clash with the graph as it is now, creating none of them", async () => {
    const harness = await conductorHarness({
      scenario: { turns: [proposeTurn("plan the parser", parserPlan)] },
    });
    await chat(harness, "plan the parser");
    await harness.post("/api/tasks", { tasks: [task("ast")] });
    const [plan] = plans(harness);

    await expect(harness.post(`/api/plans/${String(plan?.id)}/start`)).rejects.toThrow(
      'task "ast" already exists',
    );
    expect(harness.db.tasks.list().map(({ id }) => id)).toEqual(["ast"]);
  });
});
