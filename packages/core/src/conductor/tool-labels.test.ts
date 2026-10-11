import { describe, expect, it } from "vitest";
import type { Session } from "../contracts/index.js";
import { finishedLabel, runningLabel, stepDetail } from "./tool-labels.js";
import type { ToolCallRecord } from "./tool-labels.js";

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

const repoRoot = "/work/repo";

const fileCall = (name: string, input: Record<string, unknown>, output = "", isError = false) => ({
  name,
  input,
  isError,
  output,
});

describe("the rows that say what mastermind did behind the scenes", () => {
  it.each([
    {
      name: "tasks added",
      call: call("create_tasks", { tasks: [task("lexer"), task("parser")] }),
      label: "Added 2 tasks",
    },
    {
      name: "a started plan whose result lists no tasks",
      call: call("start_plan", {}, [{ id: "lexer" }]),
      label: "Started the plan",
    },
    { name: "a held task", call: call("hold", { taskId: "parser" }), label: "Held parser" },
    {
      name: "pausing all work",
      call: call("pause_all", {}),
      label: "Paused all work",
    },
    {
      name: "steering names the task of the session that took the message",
      call: call(
        "message_session",
        { sessionId: 7, text: "Use ext4" },
        { delivery: "live", session },
      ),
      label: "Sent to ext2-driver",
    },
    {
      name: "steering falls back to the session id",
      call: call("message_session", { sessionId: 9, text: "Use ext4" }, "sent"),
      label: "Sent to session 9",
    },
    {
      name: "a setting confirmed by the owner",
      call: call("set_config", { models: { worker: "sonnet" } }),
      label: "Changed models.worker to sonnet in settings",
    },
    {
      name: "the owner's branch rebase names the branch it started on",
      call: call(
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
      label: "Started rebasing dev onto main",
    },
    {
      name: "a call awaiting the owner's confirmation",
      call: call(
        "approve_rebase",
        { taskId: "lexer" },
        { status: "awaiting_confirmation", proposalId: 1, question: "Rebase lexer onto main?" },
      ),
      label: "Asked you to confirm: Rebase lexer onto main",
    },
    {
      name: "a failed action, named by what it tried",
      call: call("hold", { taskId: "lexer" }, "no such task", { isError: true }),
      label: "Hold lexer",
    },
    {
      name: "a read of the state",
      call: call("get_summary", {}),
      label: "Checked the state of the project",
    },
    {
      name: "a read of one task",
      call: call("get_task", { taskId: "lexer" }),
      label: "Looked at lexer",
    },
    {
      name: "a file read, relative to the repository",
      call: fileCall("Read", { file_path: `${repoRoot}/src/main.ts` }),
      label: "Read src/main.ts",
    },
    {
      name: "a search",
      call: fileCall("Grep", { pattern: "parseArgs" }),
      label: 'Searched for "parseArgs"',
    },
    {
      name: "a file listing",
      call: fileCall("Glob", { pattern: "src/**/*.ts" }),
      label: 'Looked for files matching "src/**/*.ts"',
    },
  ])("names $name", ({ call: made, label }) => {
    expect(finishedLabel(made, repoRoot)).toBe(label);
  });

  it.each([
    {
      name: "a file read",
      tool: "Read",
      input: { file_path: `${repoRoot}/a.ts` },
      label: "Reading a.ts",
    },
    { name: "a file read not yet described", tool: "Read", input: {}, label: "Reading a file" },
    { name: "a search", tool: "Grep", input: { pattern: "x" }, label: 'Searching for "x"' },
    { name: "a plan", tool: "mcp__mastermind__propose_plan", input: {}, label: "Drafting a plan" },
    { name: "an action", tool: "mcp__mastermind__hold", input: {}, label: "Making changes" },
    {
      name: "a read",
      tool: "mcp__mastermind__list_tasks",
      input: {},
      label: "Checking the project",
    },
  ])("says what is running for $name", ({ tool, input, label }) => {
    expect(runningLabel(tool, input, repoRoot)).toBe(label);
  });

  it.each([
    {
      name: "a file's contents",
      call: fileCall("Read", {}, "1\tconst a = 1;"),
      detail: "1\tconst a = 1;",
    },
    {
      name: "a failure's message",
      call: call("hold", {}, "no such task", { isError: true }),
      detail: '"no such task"',
    },
    {
      name: "nothing of mastermind's own answers",
      call: call("list_tasks", {}, [{ id: "lexer" }]),
      detail: null,
    },
  ])("shows $name as the detail", ({ call: made, detail }) => {
    expect(stepDetail(made)).toBe(detail);
  });
});
