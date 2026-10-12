import { expect, test } from "./harness.js";

const reply =
  "I'll update the README title and add a short description of what the app does, then commit the change.";

test.use({
  scenario: {
    turns: [
      {
        match: { role: "worker" },
        steps: [
          { kind: "read", path: "README.md" },
          { kind: "thinking", tokens: 600, streamMs: 300 },
          { kind: "text", text: reply, streamMs: 150 },
          {
            kind: "edit",
            path: "README.md",
            oldString: "# Demo",
            newString: "# Demo app\n\nSays hello.",
          },
          { kind: "hang" },
        ],
      },
    ],
  },
});

test("a running session shows its thinking, streams its reply, then numbers the lines of its edit", async ({
  page,
  mastermind,
}) => {
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  const response = await page.request.post(`${mastermind.origin}/api/tasks`, {
    headers: { authorization: `Bearer ${mastermind.token}` },
    data: {
      tasks: [
        {
          id: "retitle",
          title: "Retitle the README",
          goal: "Give the README a clearer title.",
          acceptance: "true",
          touches: ["README.md"],
        },
      ],
    },
  });
  expect(response.ok()).toBe(true);
  await page
    .getByRole("navigation", { name: "Screens" })
    .getByRole("link", { name: "Sessions" })
    .click();
  const transcript = page.getByRole("region", { name: "Transcript" });
  const progress = transcript.getByRole("status");

  await expect(transcript).toContainText("Read 2 lines");
  await expect(progress).toContainText(/Thinking…\s*\(\d+s · ↓ \d+ tokens\)/, { timeout: 15_000 });
  await expect(transcript.locator("li[aria-busy='true']")).toContainText("I'll update the README", {
    timeout: 15_000,
  });
  await expect(progress).toContainText("Working…");

  const edit = transcript.locator("details.tool-step", { hasText: "Update" });
  await expect(edit).toContainText("Updated README.md with 3 additions and 1 removal", {
    timeout: 15_000,
  });
  await expect(transcript.locator("li[aria-busy='true']")).toHaveCount(0);
  await expect(transcript).toContainText(reply);
  await edit.locator("summary").click();
  await expect(edit.locator(".diff-line")).toHaveText([
    "1- # Demo",
    "1+ # Demo app",
    "2+ ",
    "3+ Says hello.",
  ]);
});
