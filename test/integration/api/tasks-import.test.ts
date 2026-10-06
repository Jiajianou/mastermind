import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { findGraphIssues } from "@mastermind/core/actions";
import { actionResultSchemas, apiErrorSchema } from "@mastermind/core/contracts";
import type { Task } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { serveTestApi } from "./harness.js";
import type { TestApi } from "./harness.js";

const repoTasksFile = fileURLToPath(new URL("../../../tasks.yaml", import.meta.url));

function post(test: TestApi, url: string, body: unknown = {}) {
  return test.api.app.inject({
    method: "POST",
    url,
    headers: { authorization: test.authorization, "content-type": "application/json" },
    payload: JSON.stringify(body),
  });
}

async function importYaml(test: TestApi, yaml: string) {
  const response = await post(test, "/api/tasks/import", { yaml });
  expect(response.statusCode).toBe(200);
  return actionResultSchemas.importTasks.parse(response.json());
}

const graphFields = (tasks: readonly Task[]) =>
  tasks
    .map(({ id, title, goal, acceptance, touches, deps, priority }) => ({
      id,
      title,
      goal,
      acceptance,
      touches,
      deps,
      priority,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

const taskYaml = (id: string, deps: string[]) =>
  `- id: ${id}\n  title: Build ${id}\n  goal: Make ${id} work.\n  acceptance: "true"\n  touches: [src/${id}/]\n  deps: [${deps.join(", ")}]\n`;

describe("tasks.yaml import and export", () => {
  it("imports this repository's own tasks.yaml as a valid graph with its deps, warning about the extra keys", async () => {
    const test = await serveTestApi();
    const text = await readFile(repoTasksFile, "utf8");
    const file = z
      .object({ tasks: z.array(z.object({ id: z.string(), deps: z.array(z.string()) })) })
      .parse(parse(text));

    const result = await importYaml(test, text);

    const stored = test.db.tasks.list();
    expect(stored).toHaveLength(file.tasks.length);
    for (const { id, deps } of file.tasks)
      expect(test.db.tasks.get(id)?.deps).toEqual([...deps].sort());
    expect(findGraphIssues(stored)).toEqual([]);
    expect(test.db.tasks.get("m7-planning")).toMatchObject({
      deps: ["m7-tasks-board"],
      acceptance: "pnpm exec vitest run --project integration planning import",
      status: "pending",
    });
    expect(result.warnings).toEqual([
      'ignored unknown top-level key "version"',
      'ignored unknown top-level key "gate"',
      `ignored unknown key "milestone" (${String(file.tasks.length)} tasks)`,
      `ignored unknown key "tests" (${String(file.tasks.length)} tasks)`,
    ]);
  });

  it("exports tasks that import into another project as the same graph", async () => {
    const source = await serveTestApi();
    await importYaml(
      source,
      [
        taskYaml("lexer", []),
        taskYaml("parser", ["lexer"]),
        "- id: docs\n  title: Docs\n  priority: 2\n  goal: |\n    Write the docs.\n\n    Keep them short.\n  acceptance: test -f README.md\n  touches: [README.md, docs/]\n",
      ].join(""),
    );
    const target = await serveTestApi();

    const exported = await post(source, "/api/tasks/export");
    const { yaml } = actionResultSchemas.exportTasks.parse(exported.json());
    await importYaml(target, yaml);

    expect(graphFields(target.db.tasks.list())).toEqual(graphFields(source.db.tasks.list()));
    const again = await post(target, "/api/tasks/export");
    expect(actionResultSchemas.exportTasks.parse(again.json()).yaml).toBe(yaml);
  });

  it.each([
    {
      name: "a cycle, naming it",
      yaml: taskYaml("a", ["c"]) + taskYaml("b", ["a"]) + taskYaml("c", ["b"]),
      message: "dependency cycle: a → c → b → a (each task depends on the next)",
    },
    {
      name: "an unknown dependency, naming both tasks",
      yaml: taskYaml("a", []) + taskYaml("b", ["ghost"]),
      message: 'task "b" depends on "ghost", which does not exist',
    },
  ])("rejects $name, and imports none of the file", async ({ yaml, message }) => {
    const test = await serveTestApi();

    const response = await post(test, "/api/tasks/import", { yaml });

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json())).toMatchObject({
      code: "invalid_input",
      message,
    });
    expect(test.db.tasks.list()).toEqual([]);
  });
});
