import { taskViewSchema } from "@mastermind/core/contracts";
import type { Page } from "@playwright/test";
import { expect, test } from "./harness.js";
import type { ServedMastermind } from "./harness.js";

const planned = (id: string, deps: string[] = []) => ({
  id,
  title: `Build ${id}`,
  goal: `Make ${id} work.`,
  acceptance: `test -f ${id}.txt`,
  touches: [`src/${id}/`],
  deps,
});

async function pauseWork(page: Page, mastermind: ServedMastermind): Promise<void> {
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  expect((await mastermind.postApi("/api/pause", {})).ok()).toBe(true);
}

test.describe("a plan", () => {
  test.use({
    scenario: {
      turns: [
        {
          match: { role: "conductor", prompt: "plan a parser" },
          steps: [
            {
              kind: "mcp",
              tool: "propose_plan",
              arguments: {
                tasks: [
                  planned("lexer"),
                  planned("ast"),
                  { ...planned("parser", ["lexer", "ast"]), note: "after the first two" },
                ],
              },
            },
            { kind: "text", text: "Three tasks; the lexer and the AST run in parallel." },
          ],
        },
      ],
    },
  });

  test("shown in the chat becomes the task graph when Start is clicked", async ({
    page,
    mastermind,
  }) => {
    await pauseWork(page, mastermind);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("plan a parser");
    await input.press("Enter");

    const plan = page.getByRole("region", { name: "Plan" });
    await expect(plan.getByRole("listitem")).toHaveText([
      /lexer\s*Build lexer/,
      /ast\s*Build ast/,
      /parser\s*after the first two/,
    ]);
    await expect(page.getByRole("link", { name: "No tasks yet" })).toBeVisible();

    await plan.getByRole("button", { name: "Start" }).click();

    await expect(plan.getByRole("button", { name: "Started" })).toBeDisabled();
    await expect(page.getByRole("log")).not.toContainText("Plan started");
    expect(await mastermind.readApi("/api/tasks/parser", taskViewSchema)).toMatchObject({
      deps: ["ast", "lexer"],
      status: "pending",
    });
    await page
      .getByRole("navigation", { name: "Screens" })
      .getByRole("link", { name: "Tasks" })
      .click();
    const remaining = page.getByRole("region", { name: "Remaining" });
    await expect(remaining.getByRole("link")).toHaveText([/^lexer/, /^ast/, /^parser/]);
    await expect(
      remaining.getByRole("list", { name: "Waits on" }).getByRole("listitem"),
    ).toHaveText(["ast · waiting", "lexer · waiting"]);
  });
});

test("the Import tasks.yaml starter imports a file, reporting unknown keys and refusing a cycle", async ({
  page,
  mastermind,
}) => {
  await pauseWork(page, mastermind);
  const picker = page.getByLabel("tasks.yaml file");
  const upload = (yaml: string) =>
    picker.setInputFiles({ name: "tasks.yaml", mimeType: "text/yaml", buffer: Buffer.from(yaml) });
  const entry = (id: string, deps: string[]) =>
    `- id: ${id}\n  title: Build ${id}\n  goal: Make ${id} work.\n  acceptance: "true"\n  touches: [src/${id}/]\n  deps: [${deps.join(", ")}]\n  milestone: 1\n`;

  await upload(entry("a", ["b"]) + entry("b", ["a"]));

  await expect(page.getByRole("alert")).toContainText("dependency cycle: a → b → a");
  await expect(page.getByRole("link", { name: "No tasks yet" })).toBeVisible();

  await upload(entry("lexer", []) + entry("parser", ["lexer"]));

  await expect(page.getByRole("status")).toHaveText(
    'Imported 2 tasks. ignored unknown key "milestone" (2 tasks)',
  );
  expect(await mastermind.readApi("/api/tasks/parser", taskViewSchema)).toMatchObject({
    deps: ["lexer"],
  });
});
