import { taskViewSchema } from "@mastermind/core/contracts";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { expect, test } from "./harness.js";

const planned = (id: string, deps: string[], note?: string) => ({
  id,
  title: `Build the ${id}`,
  goal: `Make the ${id} work.`,
  acceptance: `test -f ${id}.txt`,
  touches: [`src/${id}/`],
  deps,
  ...(note === undefined ? {} : { note }),
});

const revisedPlan = [
  planned("lexer", []),
  planned("parser", ["lexer"]),
  planned("eval", ["parser"]),
  planned("repl", ["parser", "eval"], "once it can evaluate"),
  planned("docs", [], "alongside everything"),
];

test.use({
  scenario: {
    turns: [
      {
        match: { role: "conductor", prompt: "calculator language" },
        steps: [
          {
            kind: "mcp",
            tool: "propose_plan",
            arguments: { tasks: [planned("eval", ["repl"]), planned("repl", ["eval"])] },
          },
          {
            kind: "mcp",
            tool: "propose_plan",
            arguments: {
              tasks: [
                planned("lexer", []),
                planned("parser", ["lexer"]),
                planned("eval", ["parser"]),
                planned("repl", ["eval"]),
              ],
            },
          },
          { kind: "text", text: "Four tasks, one after another." },
        ],
      },
      {
        match: { role: "conductor", prompt: "docs" },
        steps: [
          { kind: "mcp", tool: "propose_plan", arguments: { tasks: revisedPlan } },
          { kind: "text", text: "Five tasks; the docs start right away." },
        ],
      },
    ],
  },
});

const taskLink = (id: string): RegExp => new RegExp(`^${id}`);

async function say(page: Page, message: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  await input.fill(message);
  await input.press("Enter");
}

test("a vision shared in the chat becomes the planned task graph on the board and in the graph", async ({
  page,
  mastermind,
}) => {
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  expect((await mastermind.postApi("/api/pause", {})).ok()).toBe(true);
  const log = page.getByRole("log");
  const plans = page.getByRole("region", { name: "Plan" });

  await say(page, "I want a small calculator language with a REPL.");
  await expect(log).toContainText("Four tasks, one after another.");
  await expect(plans).toHaveCount(1);
  await expect(plans.getByRole("listitem")).toHaveText([
    /lexer\s*Build the lexer/,
    /parser\s*Build the parser/,
    /eval\s*Build the eval/,
    /repl\s*Build the repl/,
  ]);
  await expect(page.getByRole("link", { name: "No tasks yet" })).toBeVisible();

  await say(page, "Write the docs too, and the REPL also needs the parser directly.");
  await expect(log).toContainText("Five tasks; the docs start right away.");
  await expect(plans).toHaveCount(2);
  const [replaced, revised] = [plans.first(), plans.last()];
  await expect(replaced).toContainText("Replaced by a newer plan");
  await expect(replaced.getByRole("button")).toHaveCount(0);
  await expect(revised.getByRole("listitem")).toHaveText([
    /lexer\s*Build the lexer/,
    /parser\s*Build the parser/,
    /eval\s*Build the eval/,
    /repl\s*once it can evaluate/,
    /docs\s*alongside everything/,
  ]);

  await revised.getByRole("button", { name: "Start" }).click();

  await expect(revised.getByRole("button", { name: "Started" })).toBeDisabled();
  await expect(log).not.toContainText("Plan started");
  const tasks = await mastermind.readApi("/api/tasks", z.array(taskViewSchema));
  expect(Object.fromEntries(tasks.map(({ id, deps, status }) => [id, { deps, status }]))).toEqual({
    lexer: { deps: [], status: "pending" },
    parser: { deps: ["lexer"], status: "pending" },
    eval: { deps: ["parser"], status: "pending" },
    repl: { deps: ["eval", "parser"], status: "pending" },
    docs: { deps: [], status: "pending" },
  });

  await page
    .getByRole("navigation", { name: "Screens" })
    .getByRole("link", { name: "Tasks" })
    .click();
  const remaining = page.getByRole("region", { name: "Remaining" });
  await expect(remaining.getByRole("link")).toHaveText(revisedPlan.map(({ id }) => taskLink(id)));
  const waitsOn = (id: string) =>
    remaining
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: taskLink(id) }) })
      .getByRole("list", { name: "Waits on" })
      .getByRole("listitem");
  await expect(waitsOn("lexer")).toHaveCount(0);
  await expect(waitsOn("eval")).toHaveText(["parser · waiting"]);
  await expect(waitsOn("repl")).toHaveText(["eval · waiting", "parser · waiting"]);
  await expect(waitsOn("docs")).toHaveCount(0);

  await page.getByRole("tab", { name: "Graph" }).click();
  const graph = page.getByRole("figure", { name: "Dependency graph" });
  for (const { id } of revisedPlan)
    await expect(graph.getByRole("link", { name: taskLink(id) })).toContainText("Waiting");
  const edges = revisedPlan.flatMap(({ id, deps }) => deps.map((dep) => [dep, id] as const));
  await expect(graph.getByRole("img", { name: /^Edge from / })).toHaveCount(edges.length);
  for (const [from, to] of edges) {
    await expect(graph.getByRole("img", { name: `Edge from ${from} to ${to}` })).toBeAttached();
    const [dependency, dependent] = await Promise.all(
      [from, to].map((id) => graph.getByRole("link", { name: taskLink(id) }).boundingBox()),
    );
    expect(dependency?.x).toBeLessThan(dependent?.x ?? Number.NEGATIVE_INFINITY);
  }
});
