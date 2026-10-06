import type { EventType, Rebase, Session, SessionEvent } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { at, check, session } from "../testing/fixtures.js";
import { contextWindow, sessionActivity } from "./activity.js";
import { elapsedText } from "./duration.js";
import { defaultSessionId, fixReason, groupSessions } from "./session-list.js";

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
    session_id: "s",
    model: "claude-opus-5-5",
    permissionMode: "bypassPermissions",
    tools: ["Edit", "Write"],
    mcp_servers: [],
  });

function toolUse(id: number, type: EventType, name: string, input: object, contextTokens = 1_000) {
  return event(id, type, {
    type: "assistant",
    session_id: "s",
    message: {
      content: [{ type: "tool_use", id: `tool-${String(id)}`, name, input }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: contextTokens - 10,
        cache_creation_input_tokens: 0,
      },
    },
  });
}

describe("elapsedText", () => {
  const started = "2026-10-06T09:00:00.000Z";

  it.each([
    { name: "seconds", now: "2026-10-06T09:00:42.000Z", endedAt: null, text: "42s" },
    { name: "minutes", now: "2026-10-06T09:04:05.000Z", endedAt: null, text: "4m 05s" },
    { name: "hours", now: "2026-10-06T10:07:59.000Z", endedAt: null, text: "1h 07m" },
    {
      name: "the run time of an ended session, whatever the clock says",
      now: "2026-10-06T15:00:00.000Z",
      endedAt: "2026-10-06T09:12:30.000Z",
      text: "12m 30s",
    },
    {
      name: "zero for a clock behind the start",
      now: "2026-10-06T08:59:00.000Z",
      endedAt: null,
      text: "0s",
    },
  ])("shows $name", ({ now, endedAt, text }) => {
    expect(elapsedText({ startedAt: started, endedAt }, new Date(now))).toBe(text);
  });
});

describe("sessionActivity", () => {
  it("adds up changed files, commits and the latest context size from the timeline", () => {
    const events = [
      init(1),
      toolUse(2, "read", "Read", { file_path: `${cwd}/README.md` }, 1_200),
      toolUse(3, "edit", "Edit", {
        file_path: `${cwd}/src/a.ts`,
        old_string: 'greeting = "hello"',
        new_string: 'greeting = "goodbye"\nprint(greeting)',
      }),
      toolUse(4, "edit", "Write", { file_path: `${cwd}/src/b.ts`, content: "one\ntwo\nthree\n" }),
      toolUse(5, "edit", "MultiEdit", {
        file_path: `${cwd}/src/a.ts`,
        edits: [
          { old_string: "x\ny", new_string: "z" },
          { old_string: "p", new_string: "q" },
        ],
      }),
      event(6, "commit", { type: "user" }, "Committed abc1234 Add greeting"),
      toolUse(
        7,
        "edit",
        "Edit",
        { file_path: "/elsewhere/c.ts", old_string: "", new_string: "c" },
        48_000,
      ),
      event(8, "error", { not: "a stream line" }, "Bash failed: exit 1"),
    ];

    expect(sessionActivity(events)).toEqual({
      latest: events[7],
      files: [
        { path: "src/a.ts", added: 4, removed: 4 },
        { path: "src/b.ts", added: 3, removed: 0 },
        { path: "/elsewhere/c.ts", added: 1, removed: 0 },
      ],
      commits: 1,
      contextTokens: 48_000,
    });
  });

  it("knows nothing yet for an empty timeline", () => {
    expect(sessionActivity([])).toEqual({
      latest: null,
      files: [],
      commits: 0,
      contextTokens: null,
    });
  });

  it("sizes the context window by model", () => {
    expect(contextWindow("opus")).toBe(200_000);
    expect(contextWindow("claude-sonnet-5[1m]")).toBe(1_000_000);
  });
});

describe("groupSessions", () => {
  const now = new Date(2026, 9, 6, 15, 0);
  const local = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).toISOString();
  const sessions: Session[] = [
    session(1, { status: "running", startedAt: local(6, 11) }),
    session(2, { status: "succeeded", startedAt: local(6, 8), endedAt: local(6, 9) }),
    session(3, { status: "running", startedAt: local(6, 10) }),
    session(4, { status: "failed", startedAt: local(6, 12), endedAt: local(6, 13) }),
    session(5, { status: "stopped", startedAt: local(5, 20), endedAt: local(5, 21) }),
    session(6, { role: "conductor", taskId: null, status: "running", startedAt: local(6, 7) }),
  ];

  it("lists active sessions oldest first, then today's finished ones newest first", () => {
    const groups = groupSessions(sessions, now);

    expect(groups.active.map(({ id }) => id)).toEqual([3, 1]);
    expect(groups.finishedToday.map(({ id }) => id)).toEqual([4, 2]);
    expect(defaultSessionId(groups)).toBe(3);
    expect(defaultSessionId(groupSessions(sessions.slice(1, 2), now))).toBe(2);
    expect(defaultSessionId(groupSessions([], now))).toBeNull();
  });
});

describe("fixReason", () => {
  const failedRebase: Rebase = {
    id: 1,
    taskId: "alpha",
    status: "failed",
    logPath: null,
    ts: at(1),
  };

  it.each([
    {
      name: "a failed rebase is a conflict",
      checks: [check(1, { status: "failed" })],
      rebase: failedRebase,
      reason: "Rebase conflict",
    },
    {
      name: "otherwise the latest failed check, with its summary",
      checks: [
        check(1, { kind: "build", status: "failed" }),
        check(2, { kind: "acceptance", status: "failed", summary: "2 tests failed" }),
        check(3, { kind: "suite", status: "passed" }),
      ],
      rebase: undefined,
      reason: "Acceptance check failed: 2 tests failed",
    },
    {
      name: "a plain reason when nothing failed yet",
      checks: [],
      rebase: undefined,
      reason: "Fixing failed checks",
    },
  ])("$name", ({ checks, rebase, reason }) => {
    expect(fixReason(checks, rebase)).toBe(reason);
  });
});
