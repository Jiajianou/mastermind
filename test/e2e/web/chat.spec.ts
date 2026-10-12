import { chatViewSchema } from "@mastermind/core/contracts";
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

  test("streams in while Stop shows, with a row for the step it took", async ({
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
    await expect(log.locator(".step")).toContainText("Added 1 task");
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
    repoFiles: {
      "README.md": "# Demo\n",
      "mastermind.yaml": "conductor:\n  confirm: [set_config]\n",
    },
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
    await expect(decision).toContainText("Change models.worker to sonnet in settings?");
    await expect(page.getByRole("link", { name: /1 needs you/ })).toBeVisible();

    await decision.getByRole("button", { name: "Change" }).click();

    await expect(decision).toContainText("Confirmed");
    await expect(decision.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("log")).toContainText(
      "Change models.worker to sonnet in settings: confirmed by the owner and done.",
    );
    await expect(page.getByRole("link", { name: "No tasks yet" })).toBeVisible();
    const config = await readFile(join(mastermind.repoPath, ".mastermind", "config.yaml"), "utf8");
    expect(config).toMatch(/worker: sonnet/);
  });
});

test.describe("a long reply", () => {
  const paragraphs = Array.from(
    { length: 60 },
    (_, index) => `Paragraph ${String(index + 1)} of a long streamed reply.`,
  );
  test.use({
    scenario: {
      turns: [
        {
          match: { role: "conductor", prompt: "write a long reply" },
          steps: [{ kind: "text", text: paragraphs.join("\n\n"), streamMs: 15 }],
        },
      ],
    },
  });

  test("scrolls only the conversation: it follows the stream, stays put once the owner scrolls up, and Jump to latest follows again", async ({
    page,
    mastermind,
  }) => {
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(input).toBeEnabled();
    await input.fill("write a long reply");
    await input.press("Enter");
    await expect(
      page.getByRole("heading", { name: `What should we build in ${mastermind.project}?` }),
    ).toBeHidden();

    const log = page.getByRole("log");
    const paragraph = (n: number) => log.getByText(`Paragraph ${String(n)} of`);
    const scrolled = () => page.locator(".chat-scroll").evaluate((pane) => pane.scrollTop);
    const fixedInPlace = async () => {
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await expect(page.getByRole("navigation", { name: "Screens" })).toBeInViewport();
      await expect(page.getByRole("navigation", { name: "Conversations" })).toBeInViewport();
    };
    await expect(paragraph(20)).toBeInViewport();
    await expect(paragraph(1)).not.toBeInViewport();
    await fixedInPlace();

    await log.hover();
    await page.mouse.wheel(0, -20_000);
    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
    await expect(paragraph(1)).toBeInViewport();
    const parked = await scrolled();
    await expect(paragraph(35)).toBeAttached();
    expect(await scrolled()).toBe(parked);
    await expect(paragraph(1)).toBeInViewport();
    await fixedInPlace();

    await page.getByRole("button", { name: "Jump to latest" }).click();

    await expect(page.getByRole("button", { name: "Jump to latest" })).toBeHidden();
    await expect(paragraph(50)).toBeInViewport();
    await expect(paragraph(60)).toBeInViewport();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    await page.mouse.wheel(0, 20_000);
    await fixedInPlace();
    expect(
      await page.evaluate(() =>
        [document.documentElement, document.body].map(
          (element) => getComputedStyle(element).overscrollBehaviorY,
        ),
      ),
    ).toEqual(["none", "none"]);
  });
});

test.describe("conversations", () => {
  test.use({
    scenario: {
      turns: [
        {
          match: { role: "conductor", prompt: "vault" },
          steps: [{ kind: "text", text: "Vault first." }],
        },
        {
          match: { role: "conductor", prompt: "sync" },
          steps: [{ kind: "text", text: "Sync later." }],
        },
        { match: { role: "conductor" }, steps: [{ kind: "text", text: "Noted." }] },
      ],
    },
  });

  test("each new conversation is named by its first message, and an earlier one opens with its own messages", async ({
    page,
    mastermind,
  }) => {
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    const log = page.getByRole("log");
    const sidebar = page.getByRole("navigation", { name: "Conversations" });
    const titles = sidebar.locator(".conversation-item");
    await expect(input).toBeEnabled();

    await input.fill("Plan the vault");
    await input.press("Enter");
    await expect(log).toContainText("Vault first.");
    await sidebar.getByRole("button", { name: "New conversation", exact: true }).click();
    await input.fill("Plan the sync");
    await input.press("Enter");
    await expect(log).toContainText("Sync later.");

    await expect(titles).toHaveText(["Plan the sync", "Plan the vault"]);
    await sidebar.getByRole("button", { name: "Plan the vault", exact: true }).click();

    await expect(log).toContainText("Vault first.");
    await expect(log).not.toContainText("Sync later.");
    await expect(
      sidebar.getByRole("button", { name: "Plan the vault", exact: true }),
    ).toHaveAttribute("aria-current", "true");
    const view = await mastermind.readApi("/api/chat", chatViewSchema);
    expect(view.conversations.find(({ id }) => id === view.conversationId)?.title).toBe(
      "Plan the vault",
    );

    await sidebar.getByRole("button", { name: "Plan the vault", exact: true }).hover();
    await sidebar.getByRole("button", { name: "Delete Plan the vault" }).click();
    await sidebar.getByRole("button", { name: "Delete", exact: true }).click();

    await expect(titles).toHaveText(["Untitled conversation", "Plan the sync"]);
    await expect(log).not.toContainText("Vault first.");
    await expect(input).toBeEnabled();
  });
});
