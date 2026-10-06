import { existsSync } from "node:fs";
import type { Page } from "@playwright/test";
import { taskSchema } from "@mastermind/core/contracts";
import type { Task } from "@mastermind/core/contracts";
import { expect, test } from "./harness.js";
import type { ServedMastermind } from "./harness.js";

const keep = "src/guarded/keep.txt";
const drop = "src/guarded/drop.txt";
const throughChecks = { timeout: 30_000 };

test.describe.configure({ timeout: 60_000 });

// keep's first draft fails its acceptance command, which the judge calls real, so a fixer finishes it before it
// waits for the owner.
test.use({
  repoFiles: {
    "README.md": "# Demo\n",
    "mastermind.yaml": "maxWorkers: 2\nrequireReviewFor: [src/guarded/]\n",
  },
  scenario: {
    turns: [
      {
        match: { role: "worker", prompt: keep },
        steps: [
          { kind: "write", path: keep, content: "draft\n" },
          { kind: "commit", message: "keep: first draft" },
          { kind: "text", text: "Done." },
        ],
      },
      {
        match: { role: "worker", prompt: drop },
        steps: [
          { kind: "write", path: drop, content: "unwanted\n" },
          { kind: "commit", message: "drop: add it" },
          { kind: "text", text: "Done." },
        ],
      },
      {
        match: { flags: ["--max-turns"] },
        steps: [
          { kind: "structuredOutput", output: { flaky: false, reason: "The file says draft." } },
        ],
      },
      {
        match: { role: "fixer" },
        steps: [
          { kind: "write", path: keep, content: "ready\n" },
          { kind: "commit", message: "keep: make it ready" },
          { kind: "text", text: "Fixed." },
        ],
      },
      {
        match: { role: "reviewer" },
        steps: [{ kind: "structuredOutput", output: { findings: [] } }],
      },
    ],
  },
});

const guardedTasks = {
  keep: {
    id: "keep",
    title: "Keep the guarded file",
    goal: `Write ready into ${keep}.`,
    acceptance: `grep -q ready ${keep}`,
    touches: [keep],
  },
  drop: {
    id: "drop",
    title: "Add an unwanted file",
    goal: `Create ${drop}.`,
    acceptance: `test -f ${drop}`,
    touches: [drop],
  },
};

const authorized = (mastermind: ServedMastermind) => ({
  headers: { authorization: `Bearer ${mastermind.token}` },
});

async function startTask(
  page: Page,
  mastermind: ServedMastermind,
  id: keyof typeof guardedTasks,
): Promise<void> {
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  const response = await page.request.post(`${mastermind.origin}/api/tasks`, {
    ...authorized(mastermind),
    data: { tasks: [guardedTasks[id]] },
  });
  expect(response.ok()).toBe(true);
}

async function readTask(page: Page, mastermind: ServedMastermind, id: string): Promise<Task> {
  const response = await page.request.get(
    `${mastermind.origin}/api/tasks/${id}`,
    authorized(mastermind),
  );
  return taskSchema.parse(await response.json());
}

async function openReadyTask(page: Page, id: string, from: "Overview" | "Review"): Promise<void> {
  await page.getByRole("navigation", { name: "Screens" }).getByRole("link", { name: from }).click();
  const link =
    from === "Overview"
      ? page.getByRole("link", { name: `${id} is ready for review` })
      : page.getByRole("navigation", { name: "Ready for review" }).getByRole("link", { name: id });
  await link.click(throughChecks);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ready for review · round 1");
}

test("a task under requireReviewFor reaches review with its checks, failed test and diff", async ({
  page,
  mastermind,
}) => {
  await startTask(page, mastermind, "keep");
  await openReadyTask(page, "keep", "Review");

  await expect(page.getByRole("region", { name: "Checks" }).getByRole("listitem")).toHaveText([
    /^Acceptance\s*Passed/,
    /^Rebase onto main\s*Passed/,
    /^Reviewer\s*Passed/,
  ]);
  const failed = page.getByRole("region", { name: "Failed test" });
  await expect(failed).toContainText("Acceptance");
  await expect(failed).toContainText("passed since");
  await expect(failed.locator(".log-tail")).toContainText(`grep -q ready ${keep}`);

  const files = page.getByRole("navigation", { name: "Files" });
  await expect(
    files.getByRole("link").filter({ hasText: "keep.txt" }).getByTitle("Added"),
  ).toBeVisible();
  const diff = page.getByRole("region", { name: `Diff ${keep}` });
  await expect(diff.locator(".editor.modified .view-lines")).toContainText("ready");
  expect((await readTask(page, mastermind, "keep")).status).toBe("review");
  expect(await mastermind.git("rev-list", "--count", "main")).toBe("1");
});

test("Approve and rebase puts the task on main as one commit", async ({ page, mastermind }) => {
  const initial = await mastermind.git("rev-parse", "main");
  await startTask(page, mastermind, "keep");
  await openReadyTask(page, "keep", "Overview");

  await page.getByRole("button", { name: "Approve and rebase" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Rebased onto main",
    throughChecks,
  );
  await expect(page.getByText("This work is on main")).toBeVisible();
  expect(await mastermind.git("rev-parse", "main~1")).toBe(initial);
  expect(await mastermind.git("log", "-1", "--format=%s", "main")).toBe("Keep the guarded file");
  expect(await mastermind.git("show", `main:${keep}`)).toBe("ready");
  expect(await mastermind.git("rev-list", "--merges", "main")).toBe("");
});

test("Discard branch removes another task's work and leaves main alone", async ({
  page,
  mastermind,
}) => {
  const initial = await mastermind.git("rev-parse", "main");
  await startTask(page, mastermind, "drop");
  await openReadyTask(page, "drop", "Overview");
  const { worktree } = await readTask(page, mastermind, "drop");
  expect(worktree !== null && existsSync(worktree)).toBe(true);
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();

  await page.getByRole("button", { name: "Discard branch" }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Waiting to start");
  await expect(page.getByRole("button", { name: "Approve and rebase" })).toBeDisabled();
  expect(existsSync(worktree ?? "")).toBe(false);
  expect(await readTask(page, mastermind, "drop")).toMatchObject({
    status: "pending",
    worktree: null,
    branch: null,
  });
  expect(await mastermind.git("for-each-ref", "refs/mastermind/")).toBe("");
  expect(await mastermind.git("rev-parse", "main")).toBe(initial);
});

test("Try it yourself runs a command in the task's clone until Stop", async ({
  page,
  mastermind,
}) => {
  await startTask(page, mastermind, "keep");
  await openReadyTask(page, "keep", "Review");
  const { worktree } = await readTask(page, mastermind, "keep");
  const tryIt = page.getByRole("region", { name: "Try it yourself" });

  await tryIt.getByRole("button", { name: "Open terminal" }).click();
  const terminal = tryIt.getByRole("region", { name: "Terminal" });
  await terminal.click();
  await page.keyboard.type("echo hi-from-try-it && pwd");
  await page.keyboard.press("Enter");

  await expect(terminal).toContainText(`hi-from-try-it${worktree ?? ""}`);
  await tryIt.getByRole("button", { name: "Stop" }).click();
  await expect(tryIt).toContainText("The terminal has ended.");
  await expect(tryIt.getByRole("button", { name: "Open a new terminal" })).toBeEnabled();
});
