import type { Task } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { at, task } from "../testing/fixtures.js";
import { taskBoard, unblocks, unmetDeps } from "./board.js";
import type { BoardColumn } from "./board.js";
import { emptyTaskForm, parseNewTask, parseTaskEdit, taskFormValues } from "./form.js";
import { graphLayout, nodeSize } from "./graph-layout.js";

const columnIds = (tasks: Task[]) =>
  Object.fromEntries(
    Object.entries(taskBoard(tasks)).map(([column, cards]) => [
      column,
      cards.map(({ task: { id } }) => id),
    ]),
  );

describe("the tasks board", () => {
  it("puts every status in its column, blocked apart under Rebasing", () => {
    const tasks = [
      task("pending", { status: "pending" }),
      task("held", { status: "pending", held: true }),
      task("running", { status: "running" }),
      task("checking", { status: "checking" }),
      task("review", { status: "review" }),
      task("rebasing", { status: "rebasing" }),
      task("blocked", { status: "blocked" }),
      task("done", { status: "done" }),
    ];

    expect(columnIds(tasks)).toEqual<Record<BoardColumn, string[]>>({
      remaining: ["held", "pending"],
      running: ["checking", "running"],
      rebasing: ["rebasing", "review"],
      blocked: ["blocked"],
      done: ["done"],
    });
  });

  it("orders Remaining by start order and Done by most recently finished", () => {
    const tasks = [
      task("low"),
      task("high", { priority: 3 }),
      task("newer", { priority: 3, createdAt: at(5) }),
      task("first-done", { status: "done", updatedAt: at(10) }),
      task("last-done", { status: "done", updatedAt: at(20) }),
    ];

    const { remaining, done } = columnIds(tasks);

    expect(remaining).toEqual(["high", "newer", "low"]);
    expect(done).toEqual(["last-done", "first-done"]);
  });
});

describe("dependencies", () => {
  const tasks = [
    task("lexer", { status: "done" }),
    task("parser", { status: "running", deps: ["lexer"] }),
    task("ast", { deps: ["lexer", "parser", "gone"] }),
    task("docs", { status: "done", deps: ["parser"] }),
  ];
  const byId = (id: string) => tasks.find((candidate) => candidate.id === id) ?? task(id);

  it.each([
    {
      id: "ast",
      unmet: [
        { id: "parser", status: "running" },
        { id: "gone", status: null },
      ],
    },
    { id: "parser", unmet: [] },
    { id: "docs", unmet: [] },
  ])("lists the unmet dependencies of $id with their statuses", ({ id, unmet }) => {
    expect(unmetDeps(byId(id), tasks)).toEqual(unmet);
  });

  it("carries unmet dependencies on the board card", () => {
    expect(taskBoard(tasks).remaining).toEqual([
      { task: byId("ast"), unmet: unmetDeps(byId("ast"), tasks) },
    ]);
  });

  it("lists the tasks a task unblocks", () => {
    expect(unblocks(byId("parser"), tasks)).toEqual([
      { id: "ast", status: "pending" },
      { id: "docs", status: "done" },
    ]);
  });

  it("lays out one node per task and an edge per known dependency, left to right", () => {
    const { nodes, edges } = graphLayout(tasks);

    expect(nodes.map(({ task: { id } }) => id)).toEqual(["lexer", "parser", "ast", "docs"]);
    expect(edges.map(({ id }) => id).sort()).toEqual([
      "lexer->ast",
      "lexer->parser",
      "parser->ast",
      "parser->docs",
    ]);
    const x = new Map(nodes.map((node) => [node.task.id, node.x]));
    for (const { from, to } of edges)
      expect(x.get(to) ?? 0).toBeGreaterThanOrEqual((x.get(from) ?? 0) + nodeSize.width);
  });
});

describe("the task form", () => {
  it("reports each invalid field with the shared schema's message", () => {
    const result = parseNewTask({
      ...emptyTaskForm,
      id: "Not A Slug",
      title: "  ",
      goal: "Parse tokens.",
      acceptance: "pnpm test",
      touches: "src/\n../outside",
      deps: "lexer, Bad Id",
      priority: "1.5",
    });

    expect(result).toEqual({
      ok: false,
      issues: {
        id: "expected a slug such as ext2-driver",
        title: "must not be empty",
        touches: "../outside: expected a path inside the repo, such as src/ or package.json",
        deps: "Bad Id: expected a slug such as ext2-driver",
        priority: "expected a whole number",
      },
    });
  });

  it("creates a task from trimmed fields and one path or id per line or comma", () => {
    const result = parseNewTask({
      id: " parser ",
      title: "Parser",
      goal: "Parse tokens.",
      acceptance: "pnpm test parser",
      touches: "src/parser/\n\n test/parser/ ",
      deps: "lexer, ast",
      priority: "2",
    });

    expect(result).toEqual({
      ok: true,
      input: {
        id: "parser",
        title: "Parser",
        goal: "Parse tokens.",
        acceptance: "pnpm test parser",
        touches: ["src/parser/", "test/parser/"],
        deps: ["lexer", "ast"],
        priority: 2,
      },
    });
  });

  it("sends only the fields an edit changed", () => {
    const stored = task("parser", { touches: ["src/"], deps: ["lexer"], priority: 1 });
    const values = taskFormValues(stored);

    expect(parseTaskEdit(stored, values)).toEqual({ ok: true, input: {} });
    expect(
      parseTaskEdit(stored, { ...values, title: "Parser v2 ", deps: "lexer\nast", priority: "1" }),
    ).toEqual({ ok: true, input: { title: "Parser v2", deps: ["lexer", "ast"] } });
  });
});
