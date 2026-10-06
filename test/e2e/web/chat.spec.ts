import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "./harness.js";

test.describe("first run", () => {
  test.use({ repoFiles: { Makefile: "build:\n\ttrue\n\ntest:\n\ttrue\n" } });

  test("asks about the detected build and test commands, and Use these settles it", async ({
    page,
    mastermind,
  }) => {
    await expect(
      page.getByRole("heading", { name: `What should we build in ${mastermind.project}?` }),
    ).toBeVisible();
    const setup = page.getByRole("region", { name: "Build and test commands" });
    await expect(setup).toContainText("make build");
    await expect(setup).toContainText("make test");
    for (const starter of ["Plan work from a goal", "Import tasks.yaml", "What can you do?"])
      await expect(page.getByRole("button", { name: starter })).toBeVisible();

    await setup.getByRole("button", { name: "Use these" }).click();

    await expect(setup).toBeHidden();
    await expect(page.getByRole("log")).toContainText(
      "Build and test commands confirmed: build make build, test make test",
    );
    await expect(page.getByRole("button", { name: "What can you do?" })).toBeVisible();

    await page.reload();

    await expect(page.getByRole("log")).toContainText("Build and test commands confirmed");
    await expect(page.getByRole("button", { name: "Plan work from a goal" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Build and test commands" })).toBeHidden();
  });
});

test.describe("a reply", () => {
  test.use({
    scenario: {
      turns: [
        {
          match: { role: "conductor", prompt: "add a hello task" },
          steps: [
            {
              kind: "mcp",
              tool: "create_tasks",
              arguments: {
                tasks: [
                  {
                    id: "hello",
                    title: "Create hello.txt",
                    goal: "Add hello.txt with a greeting.",
                    acceptance: "test -f hello.txt",
                    touches: ["hello.txt"],
                  },
                ],
              },
            },
            {
              kind: "text",
              text: "I added **hello**. A worker picks it up as soon as one is free.",
              streamMs: 150,
            },
          ],
        },
        { match: { role: "worker" }, steps: [{ kind: "hang" }] },
      ],
    },
  });

  test("streams in while Stop shows, then ends with the action line", async ({
    page,
    mastermind,
  }) => {
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(input).toBeEnabled();

    await input.fill("Please add a hello task");
    await input.press("Enter");

    const log = page.getByRole("log");
    await expect(log.locator(".bubble")).toHaveText("Please add a hello task");
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(log).toContainText("I added hello.");
    await expect(log.locator(".reply strong")).toHaveText("hello");
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(log).toContainText("A worker picks it up as soon as one is free.");
    await expect(log.locator(".action-line")).toHaveText("✓ Added 1 task");
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: /1 working · 0 needs you · 0 of 1 done/ }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: `What should we build in ${mastermind.project}?` }),
    ).toBeHidden();

    const projectConfig = join(mastermind.repoPath, ".mastermind", "config.yaml");
    await page.getByRole("combobox", { name: "Model" }).selectOption("sonnet");
    await expect.poll(() => readFile(projectConfig, "utf8")).toMatch(/conductor: sonnet/);
    await page.reload();

    await expect(page.getByRole("combobox", { name: "Model" })).toHaveValue("sonnet");
  });
});

test.describe("a decision", () => {
  test.use({
    scenario: {
      turns: [
        {
          match: { role: "conductor", prompt: "use sonnet for workers" },
          steps: [
            { kind: "mcp", tool: "set_config", arguments: { models: { worker: "sonnet" } } },
            { kind: "text", text: "Confirm the change and I'll use it." },
          ],
        },
      ],
    },
  });

  test("confirming the box applies the change and posts the outcome", async ({
    page,
    mastermind,
  }) => {
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(input).toBeEnabled();
    await input.fill("use sonnet for workers");
    await input.press("Enter");

    const decision = page.getByRole("region", { name: "Decision" });
    await expect(decision).toContainText("Change models in settings?");
    await expect(page.getByRole("link", { name: /1 needs you/ })).toBeVisible();

    await decision.getByRole("button", { name: "Change" }).click();

    await expect(decision).toContainText("Confirmed");
    await expect(decision.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("log")).toContainText(
      "Change models in settings: confirmed by the owner and done.",
    );
    await expect(page.getByRole("link", { name: "No tasks yet" })).toBeVisible();
    const config = await readFile(join(mastermind.repoPath, ".mastermind", "config.yaml"), "utf8");
    expect(config).toMatch(/worker: sonnet/);
  });
});
