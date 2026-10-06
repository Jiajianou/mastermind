import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { configSchema } from "@mastermind/core/contracts";
import { parse } from "yaml";
import { expect, test } from "./harness.js";

const projectConfig = (repoPath: string) =>
  readFile(join(repoPath, ".mastermind", "config.yaml"), "utf8").then((text): unknown =>
    parse(text),
  );

test("changing the worker model in Settings persists to config.yaml", async ({
  page,
  mastermind,
}) => {
  await page.getByRole("link", { name: "Running · Max" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const workerModel = page.getByRole("combobox", { name: "Worker model" });
  await expect(workerModel).toHaveValue("opus");

  await workerModel.selectOption("sonnet");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByRole("status")).toHaveText("Saved to .mastermind/config.yaml");
  await expect
    .poll(() => projectConfig(mastermind.repoPath))
    .toMatchObject({ models: { worker: "sonnet" } });
  const served = await mastermind.readApi("/api/config", configSchema);
  expect(served.models).toMatchObject({ worker: "sonnet", fixer: "opus", conductor: "opus" });

  await page.reload();

  await expect(page.getByRole("combobox", { name: "Worker model" })).toHaveValue("sonnet");
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
});

test.describe("a change from the chat", () => {
  test.use({
    scenario: {
      turns: [
        {
          match: { role: "conductor", prompt: "run three workers" },
          steps: [
            { kind: "mcp", tool: "set_config", arguments: { maxWorkers: 3 } },
            { kind: "text", text: "Confirm it and three workers can run at once." },
          ],
        },
      ],
    },
  });

  test("waits for the owner's confirmation, then shows in Settings", async ({
    page,
    mastermind,
  }) => {
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await expect(input).toBeEnabled();
    await input.fill("run three workers");
    await input.press("Enter");
    const decision = page.getByRole("region", { name: "Decision" });
    await expect(decision).toContainText("Change maxWorkers to 3 in settings?");
    expect(await projectConfig(mastermind.repoPath)).not.toMatchObject({ maxWorkers: 3 });

    await decision.getByRole("button", { name: "Change" }).click();
    await expect(decision).toContainText("Confirmed");
    await page.getByRole("link", { name: "Running · Max" }).click();

    await expect(page.getByRole("combobox", { name: "Parallel workers" })).toHaveValue("3");
    expect(await projectConfig(mastermind.repoPath)).toMatchObject({ maxWorkers: 3 });
  });
});
