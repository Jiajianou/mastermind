import type { EventType, SessionEvent } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { at } from "../testing/fixtures.js";
import { sessionTranscript, workingSince } from "./transcript.js";

const cwd = "/work/alpha";

function event(id: number, type: EventType, line: object, summary = `event ${String(id)}`) {
  const stored: SessionEvent = {
    id,
    sessionId: 1,
    ts: at(id),
    type,
    summary,
    payload: JSON.stringify(line),
  };
  return stored;
}

const init = (id: number) =>
  event(id, "start", {
    type: "system",
    subtype: "init",
    cwd,
    model: "claude-opus-5-5",
    permissionMode: "bypassPermissions",
    tools: [],
    mcp_servers: [],
  });

const user = (id: number, type: EventType, text: string) =>
  event(id, type, { type: "user", isReplay: true, message: { content: text } }, text);

const said = (id: number, text: string) =>
  event(id, "note", { type: "assistant", message: { content: [{ type: "text", text }] } }, text);

const call = (id: number, type: EventType, name: string, input: object) =>
  event(id, type, {
    type: "assistant",
    message: { content: [{ type: "tool_use", id: `t${String(id)}`, name, input }] },
  });

const result = (
  id: number,
  type: EventType,
  toolId: number,
  summary: string,
  content = "",
  toolUseResult?: unknown,
) =>
  event(
    id,
    type,
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: `t${String(toolId)}`,
            content,
            is_error: type === "error",
          },
        ],
      },
      tool_use_result: toolUseResult,
    },
    summary,
  );

describe("sessionTranscript", () => {
  it("reads like a Claude Code session: prompt, replies, and each tool call with its result", () => {
    const events = [
      init(1),
      user(2, "prompt", "Add a greeting.\n\nKeep it short."),
      said(3, "I'll read the file first."),
      call(4, "read", "Read", { file_path: `${cwd}/src/a.ts` }),
      result(5, "output", 4, "Read 2 lines"),
      call(6, "edit", "Edit", {
        file_path: `${cwd}/src/a.ts`,
        old_string: "a\nb",
        new_string: "a\nB\nc",
      }),
      result(7, "output", 6, "Updated src/a.ts with 2 additions and 1 removal", "", {
        structuredPatch: [
          { oldStart: 4, oldLines: 2, newStart: 4, newLines: 3, lines: [" a", "-b", "+B", "+c"] },
        ],
      }),
      call(8, "run", "Bash", { command: "pnpm test\necho done" }),
      result(9, "output", 8, "✓ 12 passed", "✓ 12 passed\n✓ done"),
      call(10, "note", "TodoWrite", {
        todos: [
          { content: "Write it", status: "completed", activeForm: "Writing it" },
          { content: "Test it", status: "in_progress", activeForm: "Testing it" },
        ],
      }),
      user(11, "steer", "Also update the README"),
      event(12, "result", { type: "result", subtype: "success" }, "Done in 4 turns"),
    ];

    expect(sessionTranscript(events, false)).toEqual([
      {
        kind: "prompt",
        key: "event-2",
        text: "Add a greeting.\n\nKeep it short.",
        fromOwner: false,
      },
      { kind: "text", key: "event-3", text: "I'll read the file first." },
      {
        kind: "tool",
        key: "tool-t4",
        name: "Read",
        target: "src/a.ts",
        status: "done",
        result: "Read 2 lines",
        detail: { kind: "none" },
      },
      {
        kind: "tool",
        key: "tool-t6",
        name: "Update",
        target: "src/a.ts",
        status: "done",
        result: "Updated src/a.ts with 2 additions and 1 removal",
        detail: {
          kind: "diff",
          lines: [
            { kind: "same", text: "a", number: 4 },
            { kind: "removed", text: "b", number: 5 },
            { kind: "added", text: "B", number: 5 },
            { kind: "added", text: "c", number: 6 },
          ],
          hidden: 0,
        },
      },
      {
        kind: "tool",
        key: "tool-t8",
        name: "Bash",
        target: "pnpm test …",
        status: "done",
        result: "✓ 12 passed",
        detail: { kind: "output", text: "✓ 12 passed\n✓ done" },
      },
      {
        kind: "tool",
        key: "tool-t10",
        name: "Update Todos",
        target: "",
        status: "unfinished",
        result: null,
        detail: {
          kind: "todos",
          todos: [
            { content: "Write it", status: "completed" },
            { content: "Test it", status: "in_progress" },
          ],
        },
      },
      { kind: "prompt", key: "event-11", text: "Also update the README", fromOwner: true },
    ]);
  });

  it.each([
    {
      name: "a denied call fails with the denial",
      outcome: event(
        3,
        "error",
        {
          type: "system",
          subtype: "permission_denied",
          tool_name: "Bash",
          tool_use_id: "t2",
          message: "needs approval",
        },
        "Denied Bash: needs approval",
      ),
      running: true,
      status: "failed",
      result: "Denied Bash: needs approval",
    },
    {
      name: "a failed call fails with its error",
      outcome: result(3, "error", 2, "Bash failed: Exit code 1", "Exit code 1"),
      running: true,
      status: "failed",
      result: "Bash failed: Exit code 1",
    },
    {
      name: "a commit finishes the call that made it",
      outcome: result(3, "commit", 2, 'Commit "Add greeting"', "[main abc1234] Add greeting"),
      running: true,
      status: "done",
      result: 'Commit "Add greeting"',
    },
    {
      name: "a call with no result yet runs while the session runs",
      outcome: null,
      running: true,
      status: "running",
      result: null,
    },
    {
      name: "a call with no result in an ended session is left unfinished",
      outcome: null,
      running: false,
      status: "unfinished",
      result: null,
    },
  ])("$name", ({ outcome, running, status, result: summary }) => {
    const events = [
      init(1),
      call(2, "run", "Bash", { command: "make" }),
      ...(outcome === null ? [] : [outcome]),
    ];

    expect(sessionTranscript(events, running)).toMatchObject([{ status, result: summary }]);
  });

  it("times the work from the latest prompt while running", () => {
    const events = [init(1), user(2, "prompt", "Go"), user(5, "steer", "Faster")];

    expect(workingSince(events, true, at(0))).toBe(at(5));
    expect(workingSince([init(1)], true, at(0))).toBe(at(0));
    expect(workingSince(events, false, at(0))).toBeNull();
  });
});
