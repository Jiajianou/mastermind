import { describe, expect, it, test } from "vitest";
import type { SessionEvent } from "../contracts/index.js";
import { createStreamParser, stuckSignals } from "./index.js";

const startedAt = "2026-10-06T09:00:00.000Z";
const at = (minute: number): Date => new Date(Date.parse(startedAt) + minute * 60_000);

const json = (value: unknown): string => JSON.stringify(value);

const init = json({
  type: "system",
  subtype: "init",
  cwd: "/work/app",
  model: "opus",
  permissionMode: "bypassPermissions",
  tools: ["Bash", "Edit"],
  mcp_servers: [],
});

let toolIds = 0;

function toolUse(name: string, input: Record<string, unknown>): { id: string; line: string } {
  toolIds += 1;
  const id = `toolu_${String(toolIds)}`;
  const line = json({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
    session_id: "s",
  });
  return { id, line };
}

const toolResult = (id: string, content: string, isError: boolean): string =>
  json({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] },
    session_id: "s",
  });

type Step = [minute: number, lines: string[]];

function run(command: string, outcome: "ok" | "fails" | "running", output = ""): string[] {
  const use = toolUse("Bash", { command });
  if (outcome === "running") return [use.line];
  const content = outcome === "fails" ? `Exit code 2\n${output}` : output;
  return [use.line, toolResult(use.id, content, outcome === "fails")];
}

const edit = (path: string, from: string, to: string): string[] => [
  toolUse("Edit", { file_path: `/work/app/${path}`, old_string: from, new_string: to }).line,
];

function sessionEvents(steps: readonly Step[]): SessionEvent[] {
  const parser = createStreamParser();
  return steps.flatMap(([minute, lines]) =>
    lines.flatMap((payload) => {
      const parsed = parser.parseLine(payload);
      if (!parsed.stored) return [];
      return [
        {
          id: 0,
          sessionId: 1,
          ts: at(minute).toISOString(),
          type: parsed.type,
          summary: parsed.summary,
          payload,
        },
      ];
    }),
  );
}

describe("stuck signals", () => {
  it("measures the minutes since the last edit, commit and output", () => {
    const events = sessionEvents([
      [0, [init]],
      [10, edit("src/lexer.ts", "a", "b")],
      [20, run('git commit -m "lexer"', "ok", "[task/lexer 1a2b3c4] lexer\n 1 file changed")],
      [30, run("make test", "ok")],
    ]);

    expect(stuckSignals({ startedAt, events, now: at(61) })).toMatchObject({
      minutesRunning: 61,
      minutesSinceEdit: 51,
      minutesSinceCommit: 41,
      minutesSinceOutput: 31,
    });
  });

  it("reports no edit or commit yet, and output since the start for a silent session", () => {
    expect(stuckSignals({ startedAt, events: [], now: at(60) })).toEqual({
      minutesRunning: 60,
      minutesSinceEdit: null,
      minutesSinceCommit: null,
      minutesSinceOutput: 60,
      repeatedFailures: [],
      backAndForthEdits: [],
      silentCommand: null,
    });
  });

  it("names the commands that keep failing, most failures first", () => {
    const events = sessionEvents([
      [0, [init]],
      [5, run("make test", "fails", "FAIL lexer.test.ts")],
      [6, run("npm run lint", "fails")],
      [7, run("make test", "fails", "FAIL lexer.test.ts")],
      [8, run("npm run lint", "fails")],
      [9, run("npm run lint", "fails")],
      [10, run("make build", "fails")],
      [11, run("make test", "fails", "FAIL lexer.test.ts")],
      [12, run("make test", "fails", "FAIL lexer.test.ts")],
      [13, run("make test", "ok")],
    ]);

    expect(stuckSignals({ startedAt, events, now: at(20) }).repeatedFailures).toEqual([
      { command: "make test", failures: 4 },
      { command: "npm run lint", failures: 3 },
    ]);
  });

  it("finds a file whose edits undo earlier edits", () => {
    const events = sessionEvents([
      [0, [init]],
      [1, edit("src/lexer.ts", "let x = 1", "const x = 1")],
      [2, edit("src/parser.ts", "a", "b")],
      [3, edit("src/lexer.ts", "const x = 1", "let x = 1")],
      [4, edit("src/lexer.ts", "let x = 1", "const x = 1")],
      [5, edit("src/parser.ts", "b", "c")],
    ]);

    expect(stuckSignals({ startedAt, events, now: at(10) }).backAndForthEdits).toEqual([
      { path: "src/lexer.ts", edits: 3, undone: 2 },
    ]);
  });

  it("does not count an earlier check's note or the owner's steering as output", () => {
    const events = sessionEvents([
      [0, [init]],
      [40, run("make test", "running")],
    ]);
    const stored = (minute: number, type: SessionEvent["type"], payload: unknown) => ({
      id: 0,
      sessionId: 1,
      ts: at(minute).toISOString(),
      type,
      summary: "",
      payload: json(payload),
    });
    events.push(
      stored(61, "note", { type: "stuck_check", minutes: 61, stuck: false }),
      stored(70, "steer", { type: "user", message: { role: "user", content: "any luck?" } }),
    );

    expect(stuckSignals({ startedAt, events, now: at(81) })).toMatchObject({
      minutesSinceOutput: 41,
      silentCommand: { command: "make test", minutes: 41 },
    });
  });

  test.each([
    {
      name: "a command with nothing stored since it started long ago is silent",
      steps: [
        [0, [init]],
        [40, run("make test", "running")],
      ] satisfies Step[],
      expected: { command: "make test", minutes: 21 },
    },
    {
      name: "a command started a moment ago is not silent yet",
      steps: [
        [0, [init]],
        [59, run("make test", "running")],
      ] satisfies Step[],
      expected: null,
    },
    {
      name: "a command followed by other events has finished",
      steps: [
        [0, [init]],
        [40, run("make test", "running")],
        [45, edit("src/lexer.ts", "a", "b")],
      ] satisfies Step[],
      expected: null,
    },
  ])("$name", ({ steps, expected }) => {
    const events = sessionEvents(steps);
    expect(stuckSignals({ startedAt, events, now: at(61) }).silentCommand).toEqual(expected);
  });
});
