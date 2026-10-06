import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Summary, TaskStatus } from "../contracts/index.js";
import { openDb } from "../db/index.js";
import { allowSandboxHostDescriber } from "../sandbox.js";
import { makeTempDir } from "../testing/temp-dir.js";
import { buildDigest, readDigestInput } from "./digest.js";
import type { DigestInput } from "./digest.js";
import { actionTools } from "./tools.js";

const now = new Date(2026, 9, 6, 14, 2);
const minutesAgo = (minutes: number): string =>
  new Date(now.getTime() - minutes * 60_000).toISOString();

function counts(values: Partial<Record<TaskStatus, number>>): Record<TaskStatus, number> {
  return {
    pending: 0,
    running: 0,
    checking: 0,
    review: 0,
    rebasing: 0,
    done: 0,
    blocked: 0,
    ...values,
  };
}

function summary(fields: Partial<Summary> = {}): Summary {
  return {
    counts: counts({}),
    activeWorkers: 0,
    maxWorkers: 2,
    upNext: [],
    blocked: [],
    paused: false,
    authRequired: false,
    resumeAt: null,
    ...fields,
  };
}

function input(fields: Partial<DigestInput> = {}): DigestInput {
  return { now, summary: summary(), running: [], review: [], decisions: [], ...fields };
}

const estimatedTokens = (text: string): number => Math.ceil(text.length / 4);

describe("buildDigest", () => {
  it("reflects counts, running sessions and what needs the owner", () => {
    const digest = buildDigest(
      input({
        summary: summary({
          counts: counts({ running: 2, review: 1, blocked: 1, pending: 4, done: 5 }),
          activeWorkers: 2,
          upNext: ["net-stack"],
          blocked: ["vfs-cache"],
        }),
        running: [
          { taskId: "ext2-driver", role: "worker", attempt: 1, startedAt: minutesAgo(12) },
          { taskId: "sched-prio", role: "fixer", attempt: 2, startedAt: minutesAgo(3) },
        ],
        review: ["sched-prio"],
        decisions: ["Rebase sched-prio onto main?"],
      }),
    );

    expect(digest.split("\n")).toEqual([
      "State at 14:02.",
      "Tasks (13): 4 pending, 2 running, 1 review, 5 done, 1 blocked.",
      "Workers: 2 of 2 busy. Running: ext2-driver (worker, attempt 1, 12m), sched-prio (fixer, attempt 2, 3m).",
      "Needs the owner: waiting for review: sched-prio; blocked: vfs-cache; waiting for a decision: Rebase sched-prio onto main?.",
      "Scheduler: running. Up next: net-stack.",
    ]);
  });

  it.each([
    { state: "idle", fields: {}, expected: "Scheduler: running." },
    { state: "paused", fields: { paused: true }, expected: "Scheduler: paused by the owner." },
    {
      state: "signed out",
      fields: { authRequired: true },
      expected: "Scheduler: waiting for the owner to sign in to Claude again.",
    },
    {
      state: "backing off",
      fields: { resumeAt: new Date(2026, 9, 6, 14, 30).toISOString() },
      expected: "Scheduler: waiting for the usage limit until 14:30.",
    },
  ])("states the scheduler when $state", ({ fields, expected }) => {
    const digest = buildDigest(input({ summary: summary(fields) }));

    expect(digest).toContain(expected);
    expect(digest).toContain("Tasks: none yet.");
    expect(digest).toContain("Needs the owner: nothing.");
  });

  it("stays within about 300 tokens on a large graph", () => {
    const longId = (index: number) => `${"subsystem-component-feature-".repeat(2)}${String(index)}`;
    const ids = Array.from({ length: 400 }, (_, index) => longId(index));
    const digest = buildDigest(
      input({
        summary: summary({
          counts: counts({
            pending: 250,
            running: 40,
            checking: 30,
            review: 40,
            rebasing: 10,
            done: 600,
            blocked: 30,
          }),
          activeWorkers: 40,
          maxWorkers: 40,
          upNext: ids.slice(0, 50),
          blocked: ids.slice(50, 80),
          paused: true,
          authRequired: true,
          resumeAt: new Date(2026, 9, 6, 15, 0).toISOString(),
        }),
        running: ids.slice(100, 140).map((taskId, index) => ({
          taskId,
          role: "worker" as const,
          attempt: 3,
          startedAt: minutesAgo(index * 7),
        })),
        review: ids.slice(200, 240),
        decisions: ids
          .slice(300, 320)
          .map((id) => `Change models, commands, sandbox and requireReviewFor of ${id}?`),
      }),
    );

    expect(estimatedTokens(digest)).toBeLessThanOrEqual(300);
    expect(digest).toContain("and 38 more");
    expect(digest).toContain("Tasks (1000)");
  });

  it("names each pending decision by its question, including mastermind's own offers", async () => {
    const clock = { now: () => now };
    const db = openDb(join(await makeTempDir(), "db.sqlite"), { clock });
    onTestFinished(() => {
      db.close();
    });
    db.proposals.create({ action: "approve", args: { taskId: "sched-prio" } });
    db.proposals.create({ action: "allowSandboxHost", args: { host: "github.com" } });
    db.proposals.create({ action: "rebaseOwnerBranch", args: { branch: "dev" } });

    const digest = buildDigest(
      readDigestInput({
        db,
        clock,
        summary: () => summary(),
        describers: [...actionTools, allowSandboxHostDescriber],
      }),
    );

    expect(digest).toContain(
      "waiting for a decision: Rebase sched-prio onto main?, Allow github.com for this project?, Rebase dev onto main?.",
    );
  });
});
