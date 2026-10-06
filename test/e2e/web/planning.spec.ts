import { taskViewSchema } from "@mastermind/core/contracts";
import { expect, test } from "./harness.js";

test("the Import tasks.yaml starter imports a file, reporting unknown keys and refusing a cycle", async ({
  page,
  mastermind,
}) => {
  await expect(page.getByRole("link", { name: "Running · Max" })).toBeVisible();
  expect((await mastermind.postApi("/api/pause", {})).ok()).toBe(true);
  const picker = page.getByLabel("tasks.yaml file");
  const upload = (yaml: string) =>
    picker.setInputFiles({ name: "tasks.yaml", mimeType: "text/yaml", buffer: Buffer.from(yaml) });
  const entry = (id: string, deps: string[]) =>
    `- id: ${id}\n  title: Build ${id}\n  goal: Make ${id} work.\n  acceptance: "true"\n  touches: [src/${id}/]\n  deps: [${deps.join(", ")}]\n  milestone: 1\n`;

  await upload(entry("a", ["b"]) + entry("b", ["a"]));

  await expect(page.getByRole("alert")).toContainText("dependency cycle: a → b → a");
  await expect(page.getByRole("link", { name: "No tasks yet" })).toBeVisible();

  await upload(entry("lexer", []) + entry("parser", ["lexer"]));

  await expect(page.getByRole("status")).toHaveText(
    'Imported 2 tasks. ignored unknown key "milestone" (2 tasks)',
  );
  expect(await mastermind.readApi("/api/tasks/parser", taskViewSchema)).toMatchObject({
    deps: ["lexer"],
  });
});
