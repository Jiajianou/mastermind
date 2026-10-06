import { taskViewSchema } from "@mastermind/core/contracts";
import type { Page } from "@playwright/test";
import { expect, test } from "./harness.js";
import type { ServedMastermind } from "./harness.js";

async function openTasks(page: Page, mastermind: ServedMastermind): Promise<void> {
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  expect((await mastermind.postApi("/api/pause", {})).ok()).toBe(true);
  const created = await mastermind.postApi("/api/tasks", {
    tasks: [
      {
        id: "lexer",
        title: "Lexer",
        goal: "Split source into tokens.",
        acceptance: "test -f lexer.txt",
        touches: ["src/lexer/"],
        priority: 2,
      },
      {
        id: "parser",
        title: "Parser",
        goal: "Build a tree from tokens.",
        acceptance: "test -f parser.txt",
        touches: ["src/parser/"],
        deps: ["lexer"],
        priority: 1,
      },
      {
        id: "docs",
        title: "Docs",
        goal: "Describe the language.",
        acceptance: "test -f docs.md",
        touches: [],
      },
    ],
  });
  expect(created.ok()).toBe(true);
  await page
    .getByRole("navigation", { name: "Screens" })
    .getByRole("link", { name: "Tasks" })
    .click();
}

test("a task can be edited, moved to the top of Remaining and held", async ({
  page,
  mastermind,
}) => {
  await openTasks(page, mastermind);
  const remaining = page.getByRole("region", { name: "Remaining" });
  await expect(remaining.getByRole("link")).toHaveText([/^lexer/, /^parser/, /^docs/]);
  await expect(remaining.getByRole("list", { name: "Waits on" })).toHaveText("lexer · waiting");

  await remaining.getByRole("link", { name: /^docs/ }).click();
  const details = page.getByRole("region", { name: "Task docs" });
  await expect(details).toContainText("Describe the language.");
  await details.getByRole("button", { name: "Edit" }).click();

  const form = page.getByRole("form", { name: "Edit docs" });
  await form.getByLabel("Title").fill(" ");
  await form.getByLabel("Touches").fill("docs/\n../outside");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(form).toContainText("Must not be empty");
  await expect(form).toContainText("../outside: expected a path inside the repo");

  await form.getByLabel("Title").fill("Write the docs");
  await form.getByLabel("Touches").fill("docs/");
  await form.getByLabel("Depends on").fill("parser");
  await form.getByRole("button", { name: "Save changes" }).click();

  await expect(details.getByRole("heading", { name: "Write the docs" })).toBeVisible();
  await expect(details).toContainText("parser waiting");
  await expect(remaining.getByRole("link", { name: /^docs/ })).toContainText("Write the docs");
  const edited = await mastermind.readApi("/api/tasks/docs", taskViewSchema);
  expect(edited).toMatchObject({ title: "Write the docs", touches: ["docs/"], deps: ["parser"] });

  await details.getByRole("button", { name: "Move to top" }).click();
  await expect(remaining.getByRole("link")).toHaveText([/^docs/, /^lexer/, /^parser/]);
  expect((await mastermind.readApi("/api/tasks/docs", taskViewSchema)).priority).toBe(3);

  await details.getByRole("button", { name: "Hold" }).click();
  await expect(details.getByRole("button", { name: "Release" })).toBeVisible();
  await expect(remaining.getByRole("link", { name: /^docs/ })).toContainText("Held");
  expect((await mastermind.readApi("/api/tasks/docs", taskViewSchema)).held).toBe(true);
});

test("the graph shows a node for every task with its status in words", async ({
  page,
  mastermind,
}) => {
  await openTasks(page, mastermind);
  await page.getByRole("tab", { name: "Graph" }).click();

  const graph = page.getByRole("figure", { name: "Dependency graph" });
  const nodes = graph.locator(".react-flow__node");
  await expect(nodes).toHaveCount(3);
  for (const id of ["lexer", "parser", "docs"])
    await expect(nodes.filter({ hasText: id })).toContainText("Waiting");
  await expect(graph.locator(".react-flow__edge")).toHaveCount(1);

  await graph.getByRole("link", { name: /^parser/ }).click();
  await expect(page).toHaveURL(/view=graph/);
  await expect(page.getByRole("region", { name: "Task parser" })).toContainText("lexer waiting");
});
