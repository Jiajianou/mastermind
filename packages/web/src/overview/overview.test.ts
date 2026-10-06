import type { Task } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { task } from "../testing/fixtures.js";
import { countTiles, needsYou, rebaseQueue } from "./board.js";
import { upNext } from "./up-next.js";

const waitingReasons = (tasks: Task[]) =>
  upNext(tasks).waiting.map(({ task: { id }, reason }) => ({ id, reason }));

describe("upNext", () => {
  it.each<{ name: string; tasks: Task[]; ready: string[] }>([
    {
      name: "lists ready tasks in start order: priority first, then oldest",
      tasks: [
        task("low", { priority: 1 }),
        task("newer", { priority: 5, createdAt: "2026-10-06T09:05:00.000Z" }),
        task("older", { priority: 5 }),
        task("busy", { status: "running" }),
      ],
      ready: ["older", "newer", "low"],
    },
    {
      name: "lets only the first of two ready tasks with shared paths start",
      tasks: [
        task("first", { priority: 2, touches: ["src/"] }),
        task("second", { touches: ["src/a.ts"] }),
      ],
      ready: ["first"],
    },
  ])("$name", ({ tasks, ready }) => {
    expect(upNext(tasks).ready.map(({ id }) => id)).toEqual(ready);
  });

  it("says what each waiting task waits on", () => {
    const tasks = [
      task("base", { status: "running", touches: ["src/core/"] }),
      task("done", { status: "done" }),
      task("held", { held: true }),
      task("deps", { deps: ["done", "base", "gone"] }),
      task("clash", { touches: ["src/core/a.ts"] }),
      task("first", { priority: 1, touches: ["docs/"] }),
      task("second", { touches: ["docs/guide.md"], createdAt: "2026-10-06T09:05:00.000Z" }),
    ];

    expect(waitingReasons(tasks)).toEqual([
      { id: "clash", reason: "Shares paths with base" },
      { id: "deps", reason: "Waits on base (running), gone (missing)" },
      { id: "held", reason: "Held" },
      { id: "second", reason: "Shares paths with first" },
    ]);
  });
});

describe("the board", () => {
  const tasks = [
    task("a", { status: "pending" }),
    task("b", { status: "running" }),
    task("c", { status: "checking" }),
    task("d", { status: "rebasing", updatedAt: "2026-10-06T09:09:00.000Z" }),
    task("e", { status: "rebasing", updatedAt: "2026-10-06T09:03:00.000Z" }),
    task("f", { status: "review" }),
    task("g", { status: "blocked" }),
    task("h", { status: "done" }),
  ];

  it("counts remaining, in-flight, done and blocked tasks out of all of them", () => {
    expect(countTiles(tasks)).toEqual({ remaining: 1, running: 4, done: 1, blocked: 1, total: 8 });
  });

  it("queues rebases oldest first", () => {
    expect(rebaseQueue(tasks).map(({ id }) => id)).toEqual(["e", "d"]);
  });

  it("asks for reviews, then blocked tasks, then decisions waiting in the chat", () => {
    expect(needsYou(tasks, 2)).toEqual([
      { kind: "review", task: tasks[5] },
      { kind: "blocked", task: tasks[6] },
      { kind: "decisions", count: 2 },
    ]);
    expect(needsYou([task("a")], 0)).toEqual([]);
  });
});
