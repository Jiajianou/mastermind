import { z } from "zod";
import { ownerEmail } from "../../fixtures/fake-claude/src/auth.js";
import { expect, test } from "./harness.js";

test("opening the link stores the token and removes it from the address bar", async ({
  page,
  mastermind,
}) => {
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  expect(page.url()).toBe(`${mastermind.origin}/`);
  const stored = z
    .record(z.string(), z.string())
    .parse(JSON.parse(await page.evaluate(() => JSON.stringify(sessionStorage))));
  expect(Object.values(stored)).toEqual([mastermind.token]);

  await page.reload();

  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("the top bar shows the project, the tabs and the account with the Ctrl+C note", async ({
  page,
  mastermind,
}) => {
  const status = page.getByRole("link", { name: "Running · Max" });
  await expect(status).toBeVisible();
  await expect(page.getByRole("banner")).toContainText(mastermind.project);
  await expect(page.getByRole("navigation", { name: "Screens" }).getByRole("link")).toHaveText([
    "Chat",
    "Overview",
    "Tasks",
    "Sessions",
    "Review",
  ]);

  await status.hover();

  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText(`${ownerEmail} · Claude Max`);
  await expect(tooltip).toContainText("Ctrl+C twice in the terminal stops mastermind");
});

const signals: NodeJS.Signals[] = ["SIGTERM", "SIGKILL"];

for (const signal of signals) {
  test(`killing the server with ${signal} shows the stopped banner`, async ({
    page,
    mastermind,
  }) => {
    await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();

    mastermind.process.child.kill(signal);

    await expect(page.getByRole("alert")).toContainText(
      "mastermind stopped (terminal closed or Ctrl+C). Run mastermind . to continue.",
      { timeout: 15_000 },
    );
    await expect(page.getByRole("button", { name: "Pause" })).toBeDisabled();
  });
}
