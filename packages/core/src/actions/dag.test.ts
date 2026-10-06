import { describe, expect, it } from "vitest";
import { describeGraphIssue, findGraphIssues } from "./dag.js";
import type { GraphNode } from "./dag.js";

const node = (id: string, ...deps: string[]): GraphNode => ({ id, deps });

describe("findGraphIssues", () => {
  it.each<{ name: string; batch: GraphNode[]; existing?: GraphNode[]; messages: string[] }>([
    {
      name: "accepts deps on tasks later in the batch and on existing tasks",
      batch: [node("parser", "lexer", "ast"), node("lexer", "tokens")],
      existing: [node("ast"), node("tokens", "ast")],
      messages: [],
    },
    {
      name: "rejects an id used twice in the batch, once",
      batch: [node("lexer"), node("parser"), node("lexer"), node("lexer")],
      messages: ['task id "lexer" is used more than once'],
    },
    {
      name: "rejects an id that already exists",
      batch: [node("lexer")],
      existing: [node("lexer")],
      messages: ['task "lexer" already exists'],
    },
    {
      name: "names the task and the unknown dependency",
      batch: [node("parser", "lexer", "ast", "ast")],
      existing: [node("lexer")],
      messages: ['task "parser" depends on "ast", which does not exist'],
    },
    {
      name: "rejects a task that depends on itself",
      batch: [node("lexer", "lexer")],
      messages: ["dependency cycle: lexer → lexer (each task depends on the next)"],
    },
    {
      name: "names every task of a cycle in order",
      batch: [node("a", "b"), node("b", "c"), node("c", "a"), node("d", "a")],
      messages: ["dependency cycle: a → b → c → a (each task depends on the next)"],
    },
    {
      name: "reports the shortest cycle through the first task of a tangle",
      batch: [node("a", "c", "b"), node("b", "a"), node("c", "d"), node("d", "a")],
      messages: ["dependency cycle: a → b → a (each task depends on the next)"],
    },
    {
      name: "reports each separate cycle",
      batch: [node("a", "b"), node("b", "a"), node("x", "y"), node("y", "x")],
      messages: [
        "dependency cycle: a → b → a (each task depends on the next)",
        "dependency cycle: x → y → x (each task depends on the next)",
      ],
    },
    {
      name: "finds a cycle closed through existing tasks",
      batch: [node("a", "c")],
      existing: [node("b", "a"), node("c", "b")],
      messages: ["dependency cycle: a → c → b → a (each task depends on the next)"],
    },
    {
      name: "ignores problems among existing tasks that the batch does not touch",
      batch: [node("a")],
      existing: [node("b", "c"), node("c", "b"), node("d", "gone")],
      messages: [],
    },
  ])("$name", ({ batch, existing, messages }) => {
    expect(findGraphIssues(batch, existing).map(describeGraphIssue)).toEqual(messages);
  });
});
