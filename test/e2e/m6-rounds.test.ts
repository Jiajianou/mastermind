import {
  commentSchema,
  fileContentSchema,
  roundSchema,
  taskChangesSchema,
} from "@mastermind/core/contracts";
import type { FileSide } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isolatedEnv } from "../support/isolated-env.js";
import { conductorToolCalls, openProjectDb, startMastermind } from "../support/mastermind.js";
import { waitFor } from "../support/processes.js";
import { createTempRepo } from "../support/temp-repo.js";

const notesFile = "src/notes.txt";
const throughChecks = 30_000;

// The project database is new, so the owner's comment is the first one.
const firstCommentId = 1;

describe("milestone 6: a review round from the chat", () => {
  it("the Conductor's request_changes resumes the worker with the comment, and the diff since round 1 shows only its change", async () => {
    const repo = await createTempRepo({
      files: { "README.md": "# Demo\n", "mastermind.yaml": "requireReviewFor: [src/]\n" },
    });
    await repo.git("switch", "--quiet", "--create", "dev");
    const env = await isolatedEnv();
    await env.writeScenario({
      turns: [
        {
          match: { role: "conductor", prompt: "add the notes task" },
          steps: [
            {
              kind: "mcp",
              tool: "create_tasks",
              arguments: {
                tasks: [
                  {
                    id: "notes",
                    title: "Write the notes",
                    goal: `Write three lines into ${notesFile}.`,
                    acceptance: `test -f ${notesFile}`,
                    touches: [notesFile],
                  },
                ],
              },
            },
            { kind: "text", text: "I added notes." },
          ],
        },
        {
          match: { role: "conductor", prompt: "send notes back" },
          steps: [
            {
              kind: "mcp",
              tool: "request_changes",
              arguments: {
                taskId: "notes",
                instruction: "Keep the other lines.",
                commentIds: [firstCommentId],
              },
            },
            { kind: "text", text: "I sent notes back." },
          ],
        },
        {
          match: { flags: ["--resume"] },
          steps: [
            { kind: "write", path: notesFile, content: "one\nTWO\nthree\n" },
            { kind: "commit", message: "notes: make two louder" },
            { kind: "text", text: "Changed." },
          ],
        },
        {
          match: { role: "worker" },
          steps: [
            { kind: "write", path: notesFile, content: "one\ntwo\nthree\n" },
            { kind: "commit", message: "notes: add them" },
            { kind: "text", text: "Done." },
          ],
        },
        {
          match: { role: "reviewer" },
          steps: [{ kind: "structuredOutput", output: { findings: [] } }],
        },
      ],
    });
    const running = await startMastermind(repo, env.env);
    const db = openProjectDb(repo);
    const { origin, token } = running.webApp;
    const api = async <Schema extends z.ZodType>(
      path: string,
      schema: Schema,
      body?: unknown,
    ): Promise<z.output<Schema>> => {
      const response = await fetch(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(response.ok, `${path} answered ${String(response.status)}`).toBe(true);
      return schema.parse(await response.json());
    };
    const waitForReview = (round: number) =>
      waitFor(() => {
        const task = db.tasks.get("notes");
        return task?.status === "review" && task.round === round && task;
      }, throughChecks);

    const added = await running.run(["chat", "add the notes task"]);
    expect(added).toMatchObject({
      code: 0,
      stderr: "",
      stdout: "I added notes.\n✓ Added 1 task\n",
    });
    await waitForReview(1);
    const comment = await api("/api/tasks/notes/comments", commentSchema, {
      file: notesFile,
      lineStart: 2,
      lineEnd: 2,
      excerpt: "two",
      text: "Make two louder.",
    });
    expect(comment).toMatchObject({ id: firstCommentId, round: 1 });

    const sent = await running.run(["chat", "send notes back with my comment"]);
    expect(sent).toMatchObject({
      code: 0,
      stderr: "",
      stdout: "I sent notes back.\n✓ Requested changes on notes (round 2)\n",
    });
    const reviewed = await waitForReview(2);

    const rounds = await api("/api/tasks/notes/rounds", z.array(roundSchema));
    expect(rounds).toMatchObject([{ round: 2, mode: "resume", commentIds: [firstCommentId] }]);
    const [round] = rounds;
    expect(round?.message).toContain("Keep the other lines.");
    expect(round?.message).toContain(`### ${notesFile}, line 2`);
    expect(round?.message).toContain("Make two louder.");
    const workers = db.sessions.listForTask("notes").filter(({ role }) => role === "worker");
    expect(workers.map(({ round: number, status }) => ({ number, status }))).toEqual([
      { number: 1, status: "succeeded" },
      { number: 2, status: "succeeded" },
    ]);
    expect(workers[1]?.claudeSessionId).toBe(workers[0]?.claudeSessionId);
    const resumed = (await env.invocations()).find(({ argv }) => argv.includes("--resume"));
    expect(resumed?.cwd).toBe(reviewed.worktree);
    expect(
      (await env.readLog()).flatMap((record) =>
        record.kind === "message" && record.pid === resumed?.pid ? [record.text] : [],
      ),
    ).toEqual([round?.message]);

    const all = await api("/api/tasks/notes/changes", taskChangesSchema);
    expect(all).toMatchObject({ since: "base", fromCommit: reviewed.baseCommit });
    expect(all.files).toMatchObject([{ path: notesFile, status: "added" }]);
    const sinceRound1 = await api("/api/tasks/notes/changes?since=round:1", taskChangesSchema);
    expect(sinceRound1).toMatchObject({ since: "round:1", fromCommit: round?.startCommit });
    expect(sinceRound1.files).toMatchObject([
      { path: notesFile, status: "modified", additions: 1, deletions: 1 },
    ]);
    const fileSinceRound1 = (side: FileSide) =>
      api(
        `/api/tasks/notes/file?path=${encodeURIComponent(notesFile)}&side=${side}&since=round:1`,
        fileContentSchema,
      );
    expect(await fileSinceRound1("base")).toMatchObject({ content: "one\ntwo\nthree\n" });
    expect(await fileSinceRound1("current")).toMatchObject({ content: "one\nTWO\nthree\n" });

    expect(conductorToolCalls(db)).toEqual([
      "mcp__mastermind__create_tasks",
      "mcp__mastermind__request_changes",
    ]);
  });
});
