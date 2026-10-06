import { describe, expect, it } from "vitest";
import { settleWorkerRun } from "./settlement.js";
import type { SessionEnd } from "./spawner.js";

const claudeSessionId = "5a7c2c55-2f5e-4c43-9a59-2b8f1a1f8f00";

describe("settling a finished worker run", () => {
  it.each<{
    name: string;
    end: SessionEnd;
    attempts?: number;
    conversationStarted?: boolean;
    expected: ReturnType<typeof settleWorkerRun>;
  }>([
    {
      name: "a success moves the task to checking",
      end: { kind: "exited", outcome: { status: "succeeded" } },
      expected: {
        sessionStatus: "succeeded",
        task: { status: "checking", attempts: 0, resumeSession: null, held: false },
        failure: null,
        effect: { kind: "succeeded" },
      },
    },
    {
      name: "a usage limit requeues for resuming without an attempt and backs off until the reset",
      end: {
        kind: "exited",
        outcome: { status: "rate_limited", resetAt: "2026-10-06T14:00:00.000Z" },
      },
      expected: {
        sessionStatus: "rate_limited",
        task: { status: "pending", attempts: 0, resumeSession: claudeSessionId, held: false },
        failure: null,
        effect: { kind: "usage-limit", resetAt: new Date("2026-10-06T14:00:00.000Z") },
      },
    },
    {
      name: "an auth failure before any work requeues a fresh start and asks for sign-in",
      end: { kind: "exited", outcome: { status: "auth_failed", reason: "Not logged in" } },
      conversationStarted: false,
      expected: {
        sessionStatus: "auth_failed",
        task: { status: "pending", attempts: 0, resumeSession: null, held: false },
        failure: null,
        effect: { kind: "auth-required" },
      },
    },
    {
      name: "an unrecognised failure counts an attempt and backs off",
      end: { kind: "exited", outcome: { status: "failed", reason: "claude exited with code 2" } },
      expected: {
        sessionStatus: "failed",
        task: { status: "pending", attempts: 1, resumeSession: null, held: false },
        failure: "claude exited with code 2",
        effect: { kind: "backoff" },
      },
    },
    {
      name: "the last allowed failure blocks the task",
      end: {
        kind: "exited",
        outcome: { status: "failed", reason: "claude ended without a result" },
      },
      attempts: 2,
      expected: {
        sessionStatus: "failed",
        task: { status: "blocked", attempts: 3, resumeSession: null, held: false },
        failure: "claude ended without a result",
        effect: { kind: "backoff" },
      },
    },
    {
      name: "a run mastermind aborted counts an attempt without a back-off",
      end: { kind: "aborted", reason: "claude ran in default mode instead of auto" },
      expected: {
        sessionStatus: "failed",
        task: { status: "pending", attempts: 1, resumeSession: null, held: false },
        failure: "claude ran in default mode instead of auto",
        effect: { kind: "none" },
      },
    },
    {
      name: "a stopped session holds its task for resuming",
      end: { kind: "stopped" },
      expected: {
        sessionStatus: "stopped",
        task: { status: "pending", attempts: 0, resumeSession: claudeSessionId, held: true },
        failure: null,
        effect: { kind: "none" },
      },
    },
  ])("$name", ({ end, attempts = 0, conversationStarted = true, expected }) => {
    expect(
      settleWorkerRun({
        report: { end, conversationStarted },
        task: { attempts, held: false },
        claudeSessionId,
        maxAttempts: 3,
      }),
    ).toEqual(expected);
  });
});
