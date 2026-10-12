import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { chatViewSchema, sessionSchema, taskViewSchema } from "@mastermind/core/contracts";
import { z } from "zod";
import { isAlive, waitFor } from "../../support/processes.js";
import { expect, test } from "./harness.js";

test.use({
  scenario: {
    turns: [
      {
        match: { role: "conductor", prompt: "remember the hello plan" },
        steps: [{ kind: "text", text: "Noted the hello plan." }],
      },
      {
        match: { role: "worker" },
        steps: [{ kind: "write", path: "hello.txt", content: "hello\n" }, { kind: "hang" }],
      },
    ],
  },
});

async function say(page: Page, message: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  await input.fill(message);
  await input.press("Enter");
}

const screens = (page: Page) => page.getByRole("navigation", { name: "Screens" });

test("Reset project stops every session and starts the project over in the same tab", async ({
  page,
  mastermind,
}) => {
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  await say(page, "remember the hello plan");
  await expect(page.getByRole("log")).toContainText("Noted the hello plan.");
  const created = await mastermind.postApi("/api/tasks", {
    tasks: [
      {
        id: "hello",
        title: "Create hello.txt",
        goal: "Add hello.txt.",
        acceptance: "test -f hello.txt",
        touches: ["hello.txt"],
      },
    ],
  });
  expect(created.ok()).toBe(true);
  const worker = await waitFor(async () => {
    const sessions = await mastermind.readApi("/api/sessions", z.array(sessionSchema));
    return sessions.find((session) => session.role === "worker" && session.pid !== null);
  });
  const [task] = await mastermind.readApi("/api/tasks", z.array(taskViewSchema));
  const workspace = task?.worktree ?? null;
  expect(workspace).not.toBeNull();

  await page.getByRole("link", { name: "Running · Max" }).click();
  const reset = page.getByRole("form", { name: "Reset project" });
  const button = reset.getByRole("button", { name: "Reset project" });
  await reset.getByRole("textbox").fill("not the project");
  await expect(button).toBeDisabled();
  await reset.getByRole("textbox").fill(mastermind.project);
  await button.click();

  await waitFor(async () => {
    const tasks = await mastermind.readApi("/api/tasks", z.array(taskViewSchema));
    return tasks.length === 0;
  }, 15_000);
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  await expect(reset.getByRole("textbox")).toHaveValue("");
  expect(isAlive(worker.pid ?? 0)).toBe(false);
  expect(workspace === null || existsSync(workspace)).toBe(false);
  expect(existsSync(join(mastermind.repoPath, ".mastermind", "config.yaml"))).toBe(true);
  expect(await mastermind.readApi("/api/tasks", z.array(taskViewSchema))).toEqual([]);
  expect(await mastermind.readApi("/api/sessions", z.array(sessionSchema))).toEqual([]);
  expect((await mastermind.readApi("/api/chat", chatViewSchema)).messages).toEqual([]);

  await screens(page).getByRole("link", { name: "Chat" }).click();
  await expect(page.getByRole("log")).not.toContainText("Noted the hello plan.");
  await screens(page).getByRole("link", { name: "Overview" }).click();
  await expect(page.getByRole("region", { name: "Active sessions" })).toContainText(
    "No sessions running.",
  );
});
