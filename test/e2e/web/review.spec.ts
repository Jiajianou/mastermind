import type { Locator, Page } from "@playwright/test";
import type { Step } from "../../support/fake-claude.js";
import { expect, test } from "./harness.js";
import type { ServedMastermind } from "./harness.js";

// The worker keeps editing README.md, uncommitted, for far longer than any test runs, so each wait depends only on
// how soon the next edit lands.
const statusEdits: Step[] = Array.from({ length: 200 }, (_, index): Step[] => [
  { kind: "sleep", ms: 600 },
  {
    kind: "edit",
    path: "README.md",
    oldString: `status-${String(index)}`,
    newString: `status-${String(index + 1)}`,
  },
]).flat();
const withinAFewSeconds = { timeout: 10_000 };

test.use({
  repoFiles: { "README.md": "# Demo\nstatus-0\n", "src/app.txt": "app\n" },
  scenario: {
    turns: [
      {
        match: { role: "worker" },
        steps: [
          { kind: "write", path: "docs/plan.md", content: "plan\n" },
          { kind: "commit", message: "Add the plan" },
          ...statusEdits,
          { kind: "hang" },
        ],
      },
    ],
  },
});

async function startStatusTask(page: Page, mastermind: ServedMastermind): Promise<void> {
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  const response = await page.request.post(`${mastermind.origin}/api/tasks`, {
    headers: { authorization: `Bearer ${mastermind.token}` },
    data: {
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
  });
  expect(response.ok()).toBe(true);
}

async function openReview(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Screens" })
    .getByRole("link", { name: "Review" })
    .click();
}

function statusShown(lines: Locator): () => Promise<number> {
  return async () => Number(/status-(\d+)/.exec(await lines.innerText())?.[1] ?? -1);
}

test("an uncommitted edit by a fake worker appears in the diff within a few seconds", async ({
  page,
  mastermind,
}) => {
  await startStatusTask(page, mastermind);
  await openReview(page);

  await expect(page.getByRole("navigation", { name: "Review sessions" })).toContainText(
    /status\s*Running · \d+ files?/,
  );
  const files = page.getByRole("navigation", { name: "Files" });
  const readme = files.getByRole("link").filter({ hasText: "README.md" });
  await expect(readme.getByTitle("Modified")).toBeVisible(withinAFewSeconds);
  await expect(readme).toContainText("editing");
  await expect(
    files.getByRole("link").filter({ hasText: "plan.md" }).getByTitle("Added"),
  ).toBeVisible();
  await readme.click();

  const diff = page.getByRole("region", { name: "Diff README.md" });
  await expect(diff).toContainText("uncommitted");
  const original = diff.locator(".editor.original .view-lines");
  const modified = diff.locator(".editor.modified .view-lines");
  await expect(original).toContainText("status-0");
  await expect.poll(statusShown(modified), withinAFewSeconds).toBeGreaterThan(0);
  const first = await statusShown(modified)();

  await expect.poll(statusShown(modified), withinAFewSeconds).toBeGreaterThan(first);
  await expect(original).toContainText("status-0");
});

test("File mode lists the whole tree and All shows each running session's latest edit", async ({
  page,
  mastermind,
}) => {
  await startStatusTask(page, mastermind);
  await openReview(page);
  await expect(page.getByRole("navigation", { name: "Files" })).toContainText(
    "README.md",
    withinAFewSeconds,
  );

  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "File" }).click();

  const files = page.getByRole("navigation", { name: "Files" });
  await expect(files.getByRole("link").filter({ hasText: "app.txt" })).toBeVisible();
  await files.getByRole("link").filter({ hasText: "app.txt" }).click();
  await expect(
    page.getByRole("region", { name: "File src/app.txt" }).locator(".view-lines"),
  ).toContainText("app");

  await page.getByRole("group", { name: "Sessions" }).getByRole("button", { name: "All" }).click();

  const pane = page.getByRole("article", { name: "status" });
  await expect(pane).toContainText("Worker · Running");
  await expect(pane).toContainText("README.md");
  await expect
    .poll(statusShown(pane.locator(".editor.modified .view-lines")), withinAFewSeconds)
    .toBeGreaterThan(0);

  await pane.getByRole("link", { name: "Open" }).click();

  await expect(page).toHaveURL(/\/review\?session=\d+&file=README\.md$/);
  await expect(page.getByRole("region", { name: "Diff README.md" })).toContainText("uncommitted");
});
