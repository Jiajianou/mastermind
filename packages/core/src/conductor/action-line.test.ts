import { describe, expect, it } from "vitest";
import type { Session } from "../contracts/index.js";
import { summariseActions } from "./action-line.js";
import type { ToolCallRecord } from "./action-line.js";

const session: Session = {
  id: 7,
  taskId: "ext2-driver",
  role: "worker",
  round: 1,
  attempt: 1,
  claudeSessionId: null,
  pid: null,
  pgid: null,
  model: "opus",
  status: "running",
  endCommit: null,
  inputTokens: null,
  outputTokens: null,
  startedAt: "2026-10-06T12:00:00.000Z",
  endedAt: null,
};

function call(
  tool: string,
  input: Record<string, unknown>,
  result: unknown = {},
  fields: Partial<ToolCallRecord> = {},
): ToolCallRecord {
  return {
    name: `mcp__mastermind__${tool}`,
    input,
    isError: false,
    output: JSON.stringify(result),
    ...fields,
  };
}

const task = (id: string): Record<string, unknown> => ({
  id,
  title: id,
  goal: "Do it",
  acceptance: "true",
  touches: [`src/${id}/`],
});

describe("the line under a reply saying what mastermind did", () => {
  it.each([
    {
      name: "tasks added",
      calls: [call("create_tasks", { tasks: [task("lexer"), task("parser")] })],
      line: "✓ Added 2 tasks",
    },
    {
      name: "a started plan whose result lists no tasks",
      calls: [call("start_plan", {}, [{ id: "lexer" }])],
      line: "✓ Started the plan",
    },
    {
      name: "graph edits and controls, joined into one sentence",
      calls: [
        call("update_task", { taskId: "lexer", title: "Lexer" }),
        call("set_priority", { taskId: "lexer", priority: 5 }),
        call("hold", { taskId: "parser" }),
        call("release", { taskId: "vfs" }),
        call("retry", { taskId: "ext2" }),
      ],
      line: "✓ Updated lexer, set the priority of lexer to 5, held parser, released vfs and retried ext2",
    },
    {
      name: "pausing, resuming and stopping",
      calls: [
        call("pause_all", {}),
        call("resume_all", {}),
        call("stop_session", { sessionId: 3 }),
      ],
      line: "✓ Paused all work, resumed work and stopped session 3",
    },
    {
      name: "steering names the task of the session that took the message",
      calls: [
        call("message_session", { sessionId: 7, text: "Use ext4" }, { delivery: "live", session }),
      ],
      line: "✓ Sent to ext2-driver",
    },
    {
      name: "steering falls back to the session id",
      calls: [call("message_session", { sessionId: 9, text: "Use ext4" }, "sent")],
      line: "✓ Sent to session 9",
    },
    {
      name: "changes requested without a readable round",
      calls: [call("request_changes", { taskId: "lexer", instruction: "Rename it" })],
      line: "✓ Requested changes on lexer",
    },
    {
      name: "a rebase, a discard and a setting confirmed by the owner",
      calls: [
        call("approve_rebase", { taskId: "lexer" }),
        call("discard_task", { taskId: "parser" }),
        call("set_config", { models: { worker: "sonnet" } }),
      ],
      line: "✓ Queued lexer to rebase onto main, discarded the work on parser and changed models.worker to sonnet in settings",
    },
    {
      name: "the owner's branch rebase names the branch it started on",
      calls: [
        call(
          "rebase_my_branch",
          {},
          {
            branch: "dev",
            status: "running",
            startedAt: "2026-10-06T12:00:00.000Z",
            endedAt: null,
            outcome: null,
            logPath: "/tmp/dev.log",
          },
        ),
      ],
      line: "✓ Started rebasing dev onto main",
    },
    {
      name: "a repeated action once",
      calls: [call("pause_all", {}), call("pause_all", {})],
      line: "✓ Paused all work",
    },
  ])("$name", ({ calls, line }) => {
    expect(summariseActions(calls)).toBe(line);
  });

  it.each([
    { name: "reads", calls: [call("get_summary", {}), call("list_tasks", {})] },
    { name: "a failed call", calls: [call("hold", { taskId: "lexer" }, "no", { isError: true })] },
    {
      name: "a call still awaiting the owner's confirmation",
      calls: [
        call(
          "approve_rebase",
          { taskId: "lexer" },
          { status: "awaiting_confirmation", proposalId: 1, question: "Rebase lexer onto main?" },
        ),
      ],
    },
    { name: "Claude's own tools", calls: [call("Read", {}, "text", { name: "Read" })] },
  ])("is left out for $name", ({ calls }) => {
    expect(summariseActions(calls)).toBeNull();
  });
});
