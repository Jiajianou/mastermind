import type { Page } from "@playwright/test";
import { roundSchema, sessionSchema } from "@mastermind/core/contracts";
import { z } from "zod";
import { expect, test } from "./harness.js";
import type { ServedMastermind } from "./harness.js";

const notesFile = "src/notes.txt";
const throughChecks = { timeout: 30_000 };

test.describe.configure({ timeout: 90_000 });

// src/ is protected, so the task waits in review after each round. The resumed session is the second round.
test.use({
  repoFiles: {
    "README.md": "# Demo\n",
    "mastermind.yaml": "requireReviewFor: [src/]\n",
  },
  scenario: {
    turns: [
      {
        match: { flags: ["--resume"] },
        steps: [
          { kind: "write", path: notesFile, content: "one\nTWO\nthree\n" },
          { kind: "commit", message: "notes: make two louder" },
          { kind: "text", text: "Changed." },
        ],
      },
      {
        match: { role: "worker" },
        steps: [
          { kind: "write", path: notesFile, content: "one\ntwo\nthree\n" },
          { kind: "commit", message: "notes: add them" },
          { kind: "text", text: "Done." },
        ],
      },
      {
        match: { role: "reviewer" },
        steps: [{ kind: "structuredOutput", output: { findings: [] } }],
      },
    ],
  },
});

const authorized = (mastermind: ServedMastermind) => ({
  headers: { authorization: `Bearer ${mastermind.token}` },
});

async function readApi<Schema extends z.ZodType>(
  page: Page,
  mastermind: ServedMastermind,
  path: string,
  schema: Schema,
): Promise<z.output<Schema>> {
  const response = await page.request.get(`${mastermind.origin}${path}`, authorized(mastermind));
  return schema.parse(await response.json());
}

test("a line comment sent as a new round comes back to review with the diff since the previous round", async ({
  page,
  mastermind,
}) => {
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  const created = await page.request.post(`${mastermind.origin}/api/tasks`, {
    ...authorized(mastermind),
    data: {
      tasks: [
        {
          id: "notes",
          title: "Write the notes",
          goal: `Write three lines into ${notesFile}.`,
          acceptance: `test -f ${notesFile}`,
          touches: [notesFile],
        },
      ],
    },
  });
  expect(created.ok()).toBe(true);

  await page
    .getByRole("navigation", { name: "Screens" })
    .getByRole("link", { name: "Review" })
    .click();
  await page
    .getByRole("navigation", { name: "Ready for review" })
    .getByRole("link", { name: "notes" })
    .click(throughChecks);
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("Ready for review · round 1");

  const diff = page.getByRole("region", { name: `Diff ${notesFile}` });
  await diff.locator(".editor.modified .view-line").filter({ hasText: "two" }).click();
  await diff.getByRole("button", { name: "Comment on line 2" }).click();
  await diff.getByRole("textbox", { name: "Comment on line 2" }).fill("Make two louder.");
  await diff.getByRole("button", { name: "Add comment" }).click();
  await expect(diff.getByRole("article", { name: `Comment on ${notesFile}` })).toContainText(
    "Make two louder.",
  );
  await expect(
    page.getByRole("navigation", { name: "Files" }).getByRole("link", { name: /notes\.txt/ }),
  ).toContainText("1 note");

  await page.getByRole("link", { name: "Request changes · 1 comment" }).click();
  await expect(page.getByText(/this becomes round 2/)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Make two louder\./ })).toBeChecked();
  await page.getByRole("textbox", { name: "Overall instruction" }).fill("Keep the other lines.");
  const preview = page.getByRole("region", { name: "Message preview" });
  await expect(preview).toContainText("Keep the other lines.");
  await expect(preview).toContainText(`### ${notesFile}, line 2`);
  await expect(preview).toContainText("Make two louder.");
  const previewText = await preview.locator(".preview-text").textContent();
  await page.getByRole("button", { name: "Send to session" }).click();

  await expect(heading).toHaveText(/round 2$/);
  await expect(heading).toHaveText("Ready for review · round 2", throughChecks);
  const [round] = await readApi(page, mastermind, "/api/tasks/notes/rounds", z.array(roundSchema));
  expect(round).toMatchObject({ round: 2, mode: "resume", message: previewText });
  const workers = (
    await readApi(page, mastermind, "/api/sessions?taskId=notes", z.array(sessionSchema))
  ).filter((session) => session.role === "worker");
  expect(workers.map(({ round: number }) => number)).toEqual([1, 2]);
  expect(workers[1]?.claudeSessionId).toBe(workers[0]?.claudeSessionId);

  const changes = page.getByRole("group", { name: "Changes" });
  await changes.getByRole("button", { name: "Since round 1" }).click();
  await expect(changes.getByRole("button", { name: "Since round 1" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(diff.getByText(/end of round 1/)).toBeVisible();
  await expect(diff.locator(".editor.modified .view-lines")).toContainText("TWO");
  await expect(diff.locator(".editor.original .view-lines")).toContainText("two");
  await changes.getByRole("button", { name: "All changes" }).click();
  await expect(diff.getByText(/^base/)).toBeVisible();
});
