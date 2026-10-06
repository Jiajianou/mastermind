import type { Page } from "@playwright/test";
import type { Step } from "../../support/fake-claude.js";
import { expect, test } from "./harness.js";
import type { ServedMastermind } from "./harness.js";

// The worker adds timeline rows for far longer than any test runs, so the waits depend only on how soon a row
// arrives, and on a loaded machine (right after the gate) the fake worker runs several times slower.
const progressSteps: Step[] = Array.from({ length: 300 }, (_, index): Step[] => [
  { kind: "sleep", ms: 150 },
  { kind: "bash", command: `echo step ${String(index + 1)}` },
]).flat();
const whileTheWorkerRuns = { timeout: 20_000 };

test.use({
  scenario: {
    turns: [
      {
        match: { role: "worker" },
        steps: [
          { kind: "read", path: "README.md" },
          { kind: "write", path: "hello.txt", content: "hello\nworld\n" },
          { kind: "commit", message: "Add hello.txt" },
          ...progressSteps,
          { kind: "hang" },
        ],
      },
    ],
  },
});

async function createHelloTask(page: Page, mastermind: ServedMastermind): Promise<void> {
  const response = await page.request.post(`${mastermind.origin}/api/tasks`, {
    headers: { authorization: `Bearer ${mastermind.token}` },
    data: {
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
  });
  expect(response.ok()).toBe(true);
}

async function openActiveSession(page: Page, mastermind: ServedMastermind) {
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  await createHelloTask(page, mastermind);
  await page
    .getByRole("navigation", { name: "Screens" })
    .getByRole("link", { name: "Sessions" })
    .click();
  await expect(page.getByRole("navigation", { name: "Session list" })).toContainText("hello");
  return page.getByRole("region", { name: "Timeline" });
}

test("a running session appears on Overview with its branch, latest action and files", async ({
  page,
  mastermind,
}) => {
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Screens" })
    .getByRole("link", { name: "Overview" })
    .click();
  await expect(page.getByRole("region", { name: "Active sessions" })).toContainText(
    "No sessions running.",
  );

  await createHelloTask(page, mastermind);

  const card = page.getByRole("article", { name: "hello" });
  await expect(card).toContainText("Worker");
  await expect(card).toContainText("Create hello.txt");
  await expect(card).toContainText("task/hello");
  await expect(card.locator(".latest-action")).toContainText(/run · Run echo step \d+/);
  await expect(card.locator(".file-changes")).toContainText("hello.txt +2 −0");
  await expect(
    page
      .getByRole("list", { name: "Task counts" })
      .getByRole("listitem")
      .filter({ hasText: "Running" }),
  ).toContainText("1");
  await expect(page.getByText("0 of 1 done")).toBeVisible();
  await expect(page.getByRole("region", { name: "Up next" })).toContainText(
    "Nothing left to start.",
  );

  await card.getByRole("link", { name: "Activity" }).click();

  await expect(page).toHaveURL(/\/sessions\?session=\d+$/);
  await expect(page.getByRole("complementary", { name: "Session facts" })).toContainText(
    "Add hello.txt with a greeting.",
  );
});

test("the timeline grows live and stops following when the owner scrolls up", async ({
  page,
  mastermind,
}) => {
  const timeline = await openActiveSession(page, mastermind);
  const rows = timeline.getByRole("row");
  await expect(rows.nth(1)).toBeVisible();
  const before = await rows.count();

  await expect.poll(() => rows.count(), whileTheWorkerRuns).toBeGreaterThan(before + 3);
  await expect(timeline.locator("tr[aria-current='true']")).toContainText("now");

  await expect(rows.nth(1)).not.toBeInViewport(whileTheWorkerRuns);
  await timeline.hover();
  await page.mouse.wheel(0, -20_000);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  const paused = await rows.count();
  await expect.poll(() => rows.count(), whileTheWorkerRuns).toBeGreaterThan(paused + 3);
  await expect(rows.nth(1)).toBeInViewport();
  await expect(rows.last()).not.toBeInViewport();

  await page.getByRole("button", { name: "Jump to latest" }).click();

  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeHidden();
  await expect(rows.last()).toBeInViewport();
});

test("Stop session stops the worker and holds its task", async ({ page, mastermind }) => {
  const timeline = await openActiveSession(page, mastermind);
  await expect(timeline.getByRole("row").nth(1)).toBeVisible();

  await page.getByRole("button", { name: "Stop session" }).click();

  const header = page.locator(".session-header");
  await expect(header).toContainText("Stopped");
  await expect(page.getByRole("button", { name: "Stop session" })).toBeHidden();
  await expect(timeline.locator("tr[aria-current='true']")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Session list" })).toContainText(
    "No sessions running.",
  );

  await page
    .getByRole("navigation", { name: "Screens" })
    .getByRole("link", { name: "Overview" })
    .click();

  await expect(page.getByRole("region", { name: "Active sessions" })).toContainText(
    "No sessions running.",
  );
  await expect(page.getByRole("region", { name: "Up next" })).toContainText("hello Held");
});
