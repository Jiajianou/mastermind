import { describe, expect, it } from "vitest";
import { taskStatusSchema } from "../contracts/index.js";
import type { TaskStatus } from "../contracts/index.js";
import { IllegalTransitionError } from "./errors.js";
import { assertTransition, canTransition } from "./transitions.js";

const legal: [TaskStatus, TaskStatus][] = [
  ["pending", "running"],
  ["running", "checking"],
  ["running", "pending"],
  ["running", "blocked"],
  ["checking", "review"],
  ["checking", "rebasing"],
  ["checking", "running"],
  ["checking", "blocked"],
  ["review", "rebasing"],
  ["review", "running"],
  ["review", "checking"],
  ["review", "pending"],
  ["rebasing", "done"],
  ["rebasing", "running"],
  ["rebasing", "blocked"],
  ["blocked", "pending"],
];

const allPairs = taskStatusSchema.options.flatMap((from) =>
  taskStatusSchema.options.map((to): [TaskStatus, TaskStatus] => [from, to]),
);
const illegal = allPairs.filter(([from, to]) => !legal.some(([f, t]) => f === from && t === to));

describe("task state machine", () => {
  it.each(legal)("allows %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => {
      assertTransition("lexer", from, to);
    }).not.toThrow();
  });

  it.each(illegal)("rejects %s → %s", (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => {
      assertTransition("lexer", from, to);
    }).toThrow(IllegalTransitionError);
  });

  it("names the task and both states when it rejects a transition", () => {
    expect(() => {
      assertTransition("lexer", "done", "pending");
    }).toThrow('task "lexer" cannot move from done to pending');
  });
});
