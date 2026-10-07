import { findGraphIssues } from "@mastermind/core/actions";
import { actionResultSchemas, apiErrorSchema } from "@mastermind/core/contracts";
import type { Task } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { serveTestApi } from "./harness.js";
import type { TestApi } from "./harness.js";

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
  it("imports a file with a dependency graph, warning about the keys it ignores", async () => {
    const test = await serveTestApi();
    const yaml = [
      "version: 1",
      "gate: pnpm verify",
      "tasks:",
      ...[
        { id: "lexer", deps: "" },
        { id: "parser", deps: "lexer" },
        { id: "checker", deps: "parser, lexer" },
      ].flatMap(({ id, deps }) => [
        `  - id: ${id}`,
        `    title: Build ${id}`,
        `    goal: Make ${id} work.`,
        `    acceptance: "true"`,
        `    touches: [src/${id}/]`,
        `    deps: [${deps}]`,
        "    milestone: m1",
        "    tests: unit",
      ]),
    ].join("\n");

    const result = await importYaml(test, yaml);

    const stored = test.db.tasks.list();
    expect(stored.map((task) => task.id).sort()).toEqual(["checker", "lexer", "parser"]);
    expect(findGraphIssues(stored)).toEqual([]);
    expect(test.db.tasks.get("checker")).toMatchObject({
      deps: ["lexer", "parser"],
      acceptance: "true",
      touches: ["src/checker/"],
      status: "pending",
    });
    expect(result.warnings).toEqual([
      'ignored unknown top-level key "version"',
      'ignored unknown top-level key "gate"',
      'ignored unknown key "milestone" (3 tasks)',
      'ignored unknown key "tests" (3 tasks)',
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
