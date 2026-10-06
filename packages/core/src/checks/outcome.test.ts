import { describe, expect, it } from "vitest";
import { decideAfterFailure, statusAfterPassing } from "./outcome.js";

describe("decideAfterFailure", () => {
  it.each([
    {
      case: "a first failure with attempts left",
      attempts: 0,
      countsAttempt: true,
      expected: { kind: "fix", attempts: 1 },
    },
    {
      case: "a failure that uses the last attempt",
      attempts: 2,
      countsAttempt: true,
      expected: { kind: "block", attempts: 3 },
    },
    {
      case: "a conflict, which is not an attempt",
      attempts: 2,
      countsAttempt: false,
      expected: { kind: "fix", attempts: 2 },
    },
  ])("$case", ({ attempts, countsAttempt, expected }) => {
    expect(decideAfterFailure({ attempts, maxAttempts: 3, countsAttempt })).toEqual(expected);
  });
});

describe("statusAfterPassing", () => {
  it.each([
    {
      case: "no protected paths",
      touches: ["src/"],
      changed: ["src/a.ts"],
      protect: [],
      autoRebase: true,
      expected: "rebasing",
    },
    {
      case: "touches under a protected path",
      touches: ["kernel/vfs/cache/"],
      changed: [],
      protect: ["kernel/vfs/"],
      autoRebase: true,
      expected: "review",
    },
    {
      case: "a changed file under a protected path",
      touches: ["src/"],
      changed: ["kernel/vfs/inode.c"],
      protect: ["kernel/vfs"],
      autoRebase: true,
      expected: "review",
    },
    {
      case: "a sibling path that only shares a prefix",
      touches: ["kernel/vfs2/"],
      changed: ["kernel/vfs2/a.c"],
      protect: ["kernel/vfs/"],
      autoRebase: true,
      expected: "rebasing",
    },
    {
      case: "autoRebase off",
      touches: ["docs/"],
      changed: ["docs/a.md"],
      protect: [],
      autoRebase: false,
      expected: "review",
    },
  ])("$case goes to $expected", ({ touches, changed, protect, autoRebase, expected }) => {
    expect(
      statusAfterPassing({ touches }, changed, { autoRebase, requireReviewFor: protect }),
    ).toBe(expected);
  });
});
