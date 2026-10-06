import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chatTurnSchema,
  commentSchema,
  findingSchema,
  requestChangesResultSchema,
  reviewNotesSchema,
} from "@mastermind/core/contracts";
import type { RoundRequest } from "@mastermind/core/sessions";
import { createTaskFiles } from "@mastermind/core/task-files";
import type { InvocationRecord } from "../../support/fake-claude.js";
import { checksHarness } from "../checks/harness.js";
import type { ChecksHarness } from "../checks/harness.js";
import { conductorHarness } from "../conductor/harness.js";

const feature = "src/feature.txt";

function flagValue({ argv }: InvocationRecord, flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function commentOnFeature(harness: ChecksHarness, text: string) {
  return commentSchema.parse(
    await harness.actions.invoke("addComment", {
      taskId: "feature",
      file: feature,
      lineStart: 1,
      lineEnd: 1,
      excerpt: "draft",
      text,
    }),
  );
}

describe("review rounds", () => {
  it("continues the same session with the request, then checks and returns the task to review", async () => {
    const harness = await checksHarness({
      config: { requireReviewFor: ["src/"] },
      scenario: {
        turns: [
          {
            match: { flags: ["--resume"] },
            steps: [
              { kind: "write", path: feature, content: "final\n" },
              { kind: "commit", message: "feature: say final" },
              { kind: "text", text: "Changed." },
            ],
          },
          {
            match: { role: "worker" },
            steps: [
              { kind: "write", path: feature, content: "draft\n" },
              { kind: "commit", message: "feature: add it" },
              { kind: "text", text: "Done." },
            ],
          },
        ],
      },
    });
    await harness.startTask("feature");
    await harness.waitForStatus("feature", "review");
    const comment = await commentOnFeature(harness, "Say final instead.");
    const [firstWorker] = harness.db.sessions.listForTask("feature");

    const started = requestChangesResultSchema.parse(
      await harness.actions.invoke("requestChanges", {
        taskId: "feature",
        instruction: "Polish the wording.",
        commentIds: [comment.id],
        mode: "resume",
      }),
    );

    expect(started.task).toMatchObject({ status: "running", round: 2, attempts: 0 });
    expect(started.session).toMatchObject({
      role: "worker",
      round: 2,
      claudeSessionId: firstWorker?.claudeSessionId,
    });
    expect(started.round).toMatchObject({
      round: 2,
      mode: "resume",
      instruction: "Polish the wording.",
      commentIds: [comment.id],
      sessionId: started.session.id,
    });
    await expect(
      harness.actions.invoke("requestChanges", { taskId: "feature", instruction: "Again." }),
    ).rejects.toThrow("only a task in review can be sent back for changes; feature is running");

    const reviewed = await harness.waitForStatus("feature", "review");
    expect(reviewed.round).toBe(2);
    expect(await readFile(join(reviewed.worktree ?? "", feature), "utf8")).toBe("final\n");
    expect(
      harness.db.checks
        .listForTask("feature")
        .filter((check) => check.round === 2)
        .map(({ kind, status }) => ({ kind, status })),
    ).toEqual([
      { kind: "build", status: "passed" },
      { kind: "acceptance", status: "passed" },
      { kind: "rebase", status: "passed" },
      { kind: "suite", status: "passed" },
    ]);

    const [, resumed] = await harness.invocationsOf("worker");
    expect(resumed?.cwd).toBe(reviewed.worktree);
    expect(resumed === undefined ? undefined : flagValue(resumed, "--resume")).toBe(
      firstWorker?.claudeSessionId,
    );
    const [, request] = await harness.promptsTo("worker");
    expect(request).toBe(started.round.message);
    expect(request).toContain("Polish the wording.");
    expect(request).toContain(
      `### ${feature}, line 1\n\n\`\`\`text\ndraft\n\`\`\`\n\nSay final instead.`,
    );
    const steer = harness.db.events
      .listForSession(started.session.id)
      .find((event) => event.type === "steer");
    expect(steer?.summary).toBe("Changes requested for round 2");

    const sinceRound = await createTaskFiles(harness).changes({
      taskId: "feature",
      since: "round:1",
    });
    expect(sinceRound.fromCommit).toBe(started.round.startCommit);
    expect(sinceRound.files).toMatchObject([
      { path: feature, status: "modified", additions: 1, deletions: 1 },
    ]);
    await expect(
      harness.actions.invoke("deleteComment", { taskId: "feature", commentId: comment.id }),
    ).rejects.toThrow("belongs to round 1, which has been sent");

    await harness.actions.invoke("discard", { taskId: "feature" });
    const pending = harness.db.tasks.get("feature");
    if (pending === null) throw new Error("feature is gone");
    await harness.manager.startTask(pending);
    await harness.waitForStatus("feature", "review");
    const [, , restarted] = await harness.invocationsOf("worker");
    expect(restarted?.argv).not.toContain("--resume");
    const [, , fromTheTop = ""] = await harness.promptsTo("worker");
    expect(fromTheTop).not.toContain("Requested changes");
    expect(harness.errors).toEqual([]);
  });

  it("starts a fresh worker with the task, a diff summary, the findings and the failing check", async () => {
    const harness = await checksHarness({
      config: { requireReviewFor: ["src/"], reviewer: { enabled: true } },
      scenario: {
        turns: [
          {
            match: { role: "worker" },
            steps: [
              { kind: "write", path: feature, content: "draft\n" },
              { kind: "write", path: "BROKEN", content: "x\n" },
              { kind: "commit", message: "feature: add it" },
              { kind: "text", text: "Done." },
            ],
          },
          {
            match: { flags: ["--max-turns"] },
            steps: [{ kind: "structuredOutput", output: { flaky: false, reason: "BROKEN." } }],
          },
          {
            match: { role: "fixer" },
            steps: [
              { kind: "bash", command: "git rm -q BROKEN && git commit -qm 'build: drop BROKEN'" },
              { kind: "text", text: "Fixed." },
            ],
          },
          {
            match: { role: "reviewer" },
            steps: [
              {
                kind: "structuredOutput",
                output: {
                  findings: [
                    { file: feature, line: 1, text: "Draft text left in.", severity: "minor" },
                  ],
                },
              },
            ],
          },
          {
            match: { role: "refine" },
            steps: [
              { kind: "write", path: feature, content: "rewritten\n" },
              { kind: "commit", message: "feature: rewrite it" },
              { kind: "text", text: "Rewritten." },
            ],
          },
        ],
      },
    });
    await harness.startTask("feature");
    const firstReview = await harness.waitForStatus("feature", "review");
    expect(firstReview.attempts).toBe(1);
    const [finding] = harness.db.findings.listForTask("feature");

    const started = requestChangesResultSchema.parse(
      await harness.actions.invoke("requestChanges", {
        taskId: "feature",
        instruction: "Start over with a cleaner approach.",
        findingIds: [finding?.id],
        includeFailingTest: true,
        mode: "fresh",
      }),
    );
    const failedBuild = harness.db.checks
      .listForTask("feature")
      .find((check) => check.kind === "build" && check.status === "failed");
    expect(started.round).toMatchObject({
      mode: "fresh",
      findingIds: [finding?.id],
      failingCheckId: failedBuild?.id,
    });
    expect(started.task).toMatchObject({ round: 2, attempts: 0 });

    const reviewed = await harness.waitForStatus("feature", "review");
    expect(reviewed.round).toBe(2);
    expect(await readFile(join(reviewed.worktree ?? "", feature), "utf8")).toBe("rewritten\n");

    const [refine] = await harness.invocationsOf("refine");
    expect(refine?.cwd).toBe(reviewed.worktree);
    expect(refine?.argv).not.toContain("--resume");
    expect(refine === undefined ? undefined : flagValue(refine, "--session-id")).toBe(
      started.session.claudeSessionId,
    );
    const [prompt = ""] = await harness.promptsTo("refine");
    expect(prompt).toContain("# Task feature: Build feature (round 2)");
    expect(prompt).toContain("## Where the work stands");
    expect(prompt).toContain(`- added ${feature} (+1 −0)`);
    expect(prompt).toContain(`## Requested changes\n\n${started.round.message}`);
    expect(started.round.message).toContain(`- minor · ${feature}:1: Draft text left in.`);
    expect(started.round.message).toContain("## Failing check: Build");
    expect(started.round.message).toContain("build failed: BROKEN is present");

    const dismissed = findingSchema.parse(
      await harness.actions.invoke("dismissFinding", { findingId: finding?.id }),
    );
    expect(dismissed.dismissed).toBe(true);
    expect(harness.events).toContainEqual({
      type: "finding.updated",
      taskId: "feature",
      finding: dismissed,
    });
    expect(harness.errors).toEqual([]);
  });

  it("reaches the same action from the chat's request_changes tool, with an action line naming the round", async () => {
    const requests: RoundRequest[] = [];
    const harness = await conductorHarness({
      scenario: {
        turns: [
          {
            match: { role: "conductor", prompt: "send parser back" },
            steps: [
              {
                kind: "mcp",
                tool: "request_changes",
                arguments: {
                  taskId: "parser",
                  instruction: "Use the new token type.",
                  commentIds: [1],
                },
              },
              { kind: "text", text: "Sent it back." },
            ],
          },
        ],
      },
      startRound: (request) => {
        requests.push(request);
        const { db } = harness;
        const session = db.sessions.create({
          role: "worker",
          taskId: "parser",
          round: 2,
          attempt: 1,
        });
        const round = db.rounds.create({
          ...request.sent,
          taskId: "parser",
          round: 2,
          mode: request.mode,
          message: request.message,
          startCommit: null,
          sessionId: session.id,
        });
        const task = db.tasks.update("parser", { status: "running", round: 2 });
        return Promise.resolve({ task, session, round });
      },
    });
    harness.db.tasks.create({
      id: "parser",
      title: "Parser",
      goal: "Parse.",
      acceptance: "true",
      touches: ["src/"],
      status: "review",
    });
    harness.db.tasks.update("parser", { worktree: "/tmp/worktrees/parser" });
    const comment = commentSchema.parse(
      await harness.post("/api/tasks/parser/comments", {
        file: "src/parse.ts",
        lineStart: 3,
        lineEnd: 4,
        excerpt: "const token = next();",
        text: "Name the token type.",
      }),
    );

    const { turnId } = chatTurnSchema.parse(
      await harness.post("/api/chat", { text: "send parser back with my comment" }),
    );
    const turn = await harness.waitForTurnEnd(turnId);

    expect(turn.at(-1)).toMatchObject({
      kind: "action",
      content: "✓ Requested changes on parser (round 2)",
    });
    expect(requests).toMatchObject([
      {
        taskId: "parser",
        mode: "resume",
        sent: { instruction: "Use the new token type.", commentIds: [comment.id], findingIds: [] },
      },
    ]);
    expect(requests[0]?.message).toContain("### src/parse.ts, lines 3–4");
    expect(requests[0]?.message).toContain("Name the token type.");
    const notes = reviewNotesSchema.parse(await harness.get("/api/tasks/parser/notes"));
    expect(notes).toMatchObject({ round: 2, comments: [comment], rounds: [{ round: 2 }] });
  });
});
