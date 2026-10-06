import { execFileSync } from "node:child_process";
import { taskViewSchema } from "@mastermind/core/contracts";
import type { TaskView } from "@mastermind/core/contracts";
import type { Locator, Page } from "@playwright/test";
import type { Step } from "../../support/fake-claude.js";
import { expect, test } from "./harness.js";
import type { ServedMastermind } from "./harness.js";

// Every edit is a shell command rather than an Edit tool call, so nothing but the command's own completion tells
// mastermind the worktree changed. The worker keeps going for far longer than the test runs.
const shellEdits: Step[] = Array.from({ length: 200 }, (_, index): Step[] => [
  { kind: "sleep", ms: 500 },
  { kind: "bash", command: `printf '# Demo\\nstatus-${String(index + 1)}\\n' > README.md` },
]).flat();
const withinAFewSeconds = { timeout: 5_000 };

test.use({
  repoFiles: { "README.md": "# Demo\nstatus-0\n" },
  scenario: {
    turns: [
      {
        match: { role: "conductor", prompt: "keep the status" },
        steps: [
          {
            kind: "mcp",
            tool: "create_tasks",
            arguments: {
              tasks: [
                {
                  id: "status",
                  title: "Keep the status current",
                  goal: "Update the status line in README.md.",
                  acceptance: "grep status README.md",
                  touches: ["README.md"],
                },
              ],
            },
          },
          { kind: "text", text: "I added **status**." },
        ],
      },
      { match: { role: "worker" }, steps: [...shellEdits, { kind: "hang" }] },
    ],
  },
});

async function say(page: Page, message: string): Promise<void> {
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(input).toBeEnabled();
  await input.fill(message);
  await input.press("Enter");
}

function statusShown(lines: Locator): () => Promise<number> {
  return async () => Number(/status-(\d+)/.exec(await lines.innerText())?.[1] ?? -1);
}

async function readTask(page: Page, mastermind: ServedMastermind, id: string): Promise<TaskView> {
  const response = await page.request.get(`${mastermind.origin}/api/tasks/${id}`, {
    headers: { authorization: `Bearer ${mastermind.token}` },
  });
  return taskViewSchema.parse(await response.json());
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

test("a task added by chat shows its worker's uncommitted shell edits in the diff within a few seconds", async ({
  page,
  mastermind,
}) => {
  await say(page, "Please keep the status line current");
  await expect(page.getByRole("log")).toContainText("I added status.");
  await page.getByRole("link", { name: "1 working · 0 needs you · 0 of 1 done" }).click();
  await page
    .getByRole("article", { name: "status" })
    .getByRole("link", { name: "View diff" })
    .click();

  const readme = page
    .getByRole("navigation", { name: "Files" })
    .getByRole("link")
    .filter({ hasText: "README.md" });
  await expect(readme.getByTitle("Modified")).toBeVisible(withinAFewSeconds);
  await readme.click();
  const diff = page.getByRole("region", { name: "Diff README.md" });
  await expect(diff).toContainText("uncommitted");
  const original = diff.locator(".editor.original .view-lines");
  const modified = diff.locator(".editor.modified .view-lines");
  await expect.poll(statusShown(modified), withinAFewSeconds).toBeGreaterThan(0);
  const seen = await statusShown(modified)();

  await expect.poll(statusShown(modified), withinAFewSeconds).toBeGreaterThan(seen);
  await expect(original).toContainText("status-0");
  const { worktree, baseCommit } = await readTask(page, mastermind, "status");
  if (worktree === null || baseCommit === null) throw new Error("status has no workspace");
  expect(git(worktree, "rev-parse", "HEAD")).toBe(baseCommit);
  expect(git(worktree, "status", "--porcelain")).toBe("M README.md");
});
