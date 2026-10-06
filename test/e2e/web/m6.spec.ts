import { findingSchema, roundSchema, sessionSchema } from "@mastermind/core/contracts";
import { z } from "zod";
import { expect, test } from "./harness.js";

const notesFile = "src/notes.txt";
const throughChecks = { timeout: 30_000 };

test.describe.configure({ timeout: 120_000 });

// src/ is protected, so the task waits in review after each round. The fresh session of round 2 runs with the
// refine system prompt, which fake-claude reports as the refine role.
test.use({
  repoFiles: {
    "README.md": "# Demo\n",
    "mastermind.yaml": "requireReviewFor: [src/]\n",
  },
  scenario: {
    turns: [
      {
        match: { role: "worker" },
        steps: [
          { kind: "write", path: notesFile, content: "one\ntwo\nthree\n" },
          { kind: "commit", message: "notes: add them" },
          { kind: "text", text: "Done." },
        ],
      },
      {
        match: { role: "refine" },
        steps: [
          { kind: "write", path: notesFile, content: "one\nTWO\nTHREE\n" },
          { kind: "commit", message: "notes: make them louder" },
          { kind: "text", text: "Rewritten." },
        ],
      },
      {
        match: { role: "reviewer", prompt: "THREE" },
        steps: [{ kind: "structuredOutput", output: { findings: [] } }],
      },
      {
        match: { role: "reviewer" },
        steps: [
          {
            kind: "structuredOutput",
            output: {
              findings: [
                { file: notesFile, line: 3, text: "Three is too quiet.", severity: "minor" },
              ],
            },
          },
        ],
      },
    ],
  },
});

test("a comment and a finding sent to a fresh session come back as round 2, which is approved onto main", async ({
  page,
  mastermind,
}) => {
  const initialMain = await mastermind.git("rev-parse", "main");
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  const created = await mastermind.postApi("/api/tasks", {
    tasks: [
      {
        id: "notes",
        title: "Write the notes",
        goal: `Write three lines into ${notesFile}.`,
        acceptance: `test -f ${notesFile}`,
        touches: [notesFile],
      },
    ],
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
  await expect(diff.getByRole("article", { name: `Minor finding on ${notesFile}` })).toContainText(
    "Three is too quiet.",
  );
  await diff.locator(".editor.modified .view-line").filter({ hasText: "two" }).click();
  await diff.getByRole("button", { name: "Comment on line 2" }).click();
  await diff.getByRole("textbox", { name: "Comment on line 2" }).fill("Make two louder.");
  await diff.getByRole("button", { name: "Add comment" }).click();
  await expect(diff.getByRole("article", { name: `Comment on ${notesFile}` })).toContainText(
    "Make two louder.",
  );

  await page.getByRole("link", { name: "Request changes · 1 comment" }).click();
  await expect(page.getByText(/this becomes round 2/)).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /Make two louder\./ })).toBeChecked();
  const finding = page.getByRole("checkbox", { name: /Three is too quiet\./ });
  await expect(finding).not.toBeChecked();
  await finding.check();
  await page.getByRole("radio", { name: /Start a fresh session/ }).check();
  await page.getByRole("textbox", { name: "Overall instruction" }).fill("Make every line louder.");
  const preview = page.getByRole("region", { name: "Message preview" });
  await expect(preview).toContainText("a summary of the diff");
  await expect(preview).toContainText("Make every line louder.");
  await expect(preview).toContainText(`### ${notesFile}, line 2`);
  await expect(preview).toContainText(`- minor · ${notesFile}:3: Three is too quiet.`);
  const previewText = await preview.locator(".preview-text").textContent();
  await page.getByRole("button", { name: "Send to session" }).click();

  await expect(heading).toHaveText(/round 2$/);
  await expect(heading).toHaveText("Ready for review · round 2", throughChecks);
  const findings = await mastermind.readApi("/api/tasks/notes/findings", z.array(findingSchema));
  expect(findings).toMatchObject([{ round: 1, text: "Three is too quiet." }]);
  const rounds = await mastermind.readApi("/api/tasks/notes/rounds", z.array(roundSchema));
  expect(rounds).toMatchObject([
    { round: 2, mode: "fresh", message: previewText, findingIds: findings.map(({ id }) => id) },
  ]);
  const workers = (
    await mastermind.readApi("/api/sessions?taskId=notes", z.array(sessionSchema))
  ).filter((session) => session.role === "worker");
  expect(workers.map(({ round: number }) => number)).toEqual([1, 2]);
  expect(workers[1]?.claudeSessionId).not.toBe(workers[0]?.claudeSessionId);

  const changes = page.getByRole("group", { name: "Changes" });
  await changes.getByRole("button", { name: "Since round 1" }).click();
  await expect(diff.getByText(/end of round 1/)).toBeVisible();
  await expect(diff.locator(".editor.original .view-lines")).toContainText("two");
  await expect(diff.locator(".editor.modified .view-lines")).toContainText("TWO");

  await page.getByRole("button", { name: "Approve and rebase" }).click();
  await expect(heading).toHaveText("Rebased onto main", throughChecks);
  expect(await mastermind.git("rev-parse", "main~1")).toBe(initialMain);
  expect(await mastermind.git("show", `main:${notesFile}`)).toBe("one\nTWO\nTHREE");
  expect(await mastermind.git("rev-list", "--merges", "main")).toBe("");
});
