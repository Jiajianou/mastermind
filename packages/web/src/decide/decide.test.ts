import type { TaskStatus } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { check } from "../testing/fixtures.js";
import { latestFailure, logTail, roundChecks } from "./checks.js";
import { availableDecisions, decideHeadline } from "./task-state.js";

describe("roundChecks", () => {
  it("lists the latest check of each kind in the round, in pipeline order", () => {
    const checks = [
      check(7, { kind: "reviewer", status: "passed" }),
      check(2, { kind: "acceptance", status: "failed" }),
      check(1, { kind: "build", status: "passed" }),
      check(5, { kind: "acceptance", status: "passed" }),
      check(6, { kind: "rebase", status: "running" }),
      check(9, { kind: "build", status: "failed", round: 2 }),
    ];

    expect(roundChecks(checks, 1).map(({ id, kind }) => [id, kind])).toEqual([
      [1, "build"],
      [5, "acceptance"],
      [6, "rebase"],
      [7, "reviewer"],
    ]);
  });
});

describe("latestFailure", () => {
  it.each([
    { name: "no failure", checks: [check(1, { status: "passed" })], expected: null },
    {
      name: "a failure still standing",
      checks: [check(1, { status: "passed" }), check(2, { kind: "suite", status: "failed" })],
      expected: { id: 2, passedSince: false },
    },
    {
      name: "a failure a later check of its kind passed",
      checks: [
        check(3, { kind: "acceptance", status: "passed" }),
        check(1, { kind: "acceptance", status: "failed" }),
        check(2, { kind: "build", status: "passed" }),
      ],
      expected: { id: 1, passedSince: true },
    },
    {
      name: "a failure of an earlier round",
      checks: [check(1, { status: "failed" }), check(2, { status: "passed", round: 2 })],
      round: 2,
      expected: null,
    },
  ])("finds $name", ({ checks, round = 1, expected }) => {
    const failure = latestFailure(checks, round);
    expect(
      failure === null ? null : { id: failure.check.id, passedSince: failure.passedSince },
    ).toEqual(expected);
  });
});

describe("decide header", () => {
  it.each<{ status: TaskStatus; headline: string; enabled: string[] }>([
    {
      status: "review",
      headline: "Ready for review · round 2",
      enabled: ["approve", "discard", "rerun"],
    },
    { status: "checking", headline: "Checks running · round 2", enabled: [] },
    { status: "rebasing", headline: "Rebasing onto main · round 2", enabled: [] },
    { status: "blocked", headline: "Blocked · round 2", enabled: ["discard"] },
    { status: "done", headline: "Rebased onto main", enabled: [] },
    { status: "pending", headline: "Waiting to start", enabled: [] },
  ])("a $status task reads “$headline”", ({ status, headline, enabled }) => {
    expect(decideHeadline({ status, round: 2 })).toBe(headline);
    const decisions = Object.entries(availableDecisions(status));
    expect(decisions.filter(([, allowed]) => allowed).map(([name]) => name)).toEqual(enabled);
  });
});

describe("logTail", () => {
  it("keeps the last lines and says when it cut some", () => {
    expect(logTail("a\nb\nc\nd\n\n", 2)).toEqual({ text: "c\nd", cut: true });
    expect(logTail("a\nb\n", 5)).toEqual({ text: "a\nb", cut: false });
  });
});
