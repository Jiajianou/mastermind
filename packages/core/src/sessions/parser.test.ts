import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { EventType, ExitOutcome } from "../contracts/index.js";
import {
  classifyExit,
  createStreamParser,
  readStructuredOutput,
  StructuredOutputError,
} from "./index.js";
import type { ParsedEvent } from "./index.js";

const samplesDir = new URL("../../../../test/fixtures/claude-samples/", import.meta.url);

function sampleLines(name: string): string[] {
  return readFileSync(new URL(name, samplesDir), "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

function parseAll(lines: readonly string[]): ParsedEvent[] {
  const parser = createStreamParser();
  return lines.map((line) => parser.parseLine(line));
}

function storedRows(events: readonly ParsedEvent[]): [EventType, string][] {
  return events.filter((event) => event.stored).map((event) => [event.type, event.summary]);
}

function lastResult(events: readonly ParsedEvent[]): ParsedEvent | null {
  return events.findLast((event) => event.details.line === "result") ?? null;
}

const json = (value: unknown): string => JSON.stringify(value);

const toolUse = (id: string, name: string, input: Record<string, unknown>): string =>
  json({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
    session_id: "s",
  });

const toolResult = (
  id: string,
  content: string,
  extra: { isError?: boolean; toolUseResult?: unknown } = {},
): string =>
  json({
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: id, content, is_error: extra.isError ?? false },
      ],
    },
    tool_use_result: extra.toolUseResult,
    session_id: "s",
  });

const resultLine = (fields: Record<string, unknown>): string =>
  json({ type: "result", subtype: "success", is_error: false, num_turns: 1, ...fields });

const errorResult = (text: string, apiErrorStatus: number | null = null): string =>
  resultLine({ is_error: true, result: text, api_error_status: apiErrorStatus });

const syntheticError = (error: string, text: string): string =>
  json({ type: "assistant", message: { content: [{ type: "text", text }] }, error });

const rateLimit = (status: string, resetsAt: number): string =>
  json({
    type: "rate_limit_event",
    rate_limit_info: { status, resetsAt, rateLimitType: "five_hour" },
  });

type Row = [EventType, string | RegExp];

const expectedBySample: Record<string, Row[]> = {
  "01-worker-run.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · bypassPermissions · 38 tools"],
    ["read", "Read hello.py"],
    ["edit", "Edit hello.py"],
    ["run", "Run python3 hello.py && echo ran"],
    ["run", 'Run git add -A && git commit -m "Say goodbye"'],
    ["commit", 'Commit "Say goodbye"'],
    ["note", "done"],
    ["result", "Done in 5 turns"],
  ],
  "01-partial-messages.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · default · 1 tool"],
    ["read", "Read README.md"],
    ["note", /^The README states that the repository has a README file\./],
    ["result", "Done in 2 turns"],
  ],
  "02-json-schema.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · default · 1 tool"],
    ["note", "Structured output"],
    ["result", "Done in 2 turns"],
  ],
  "03-rate-limit-events.jsonl": [],
  "04-auth-invalid-token.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · default · 0 tools"],
    ["note", "API retry 1/10 (authentication_failed)"],
    ["note", "API retry 2/10 (authentication_failed)"],
    [
      "error",
      "Failed to authenticate. API Error: 401 OAuth access token is invalid. (authentication_failed)",
    ],
    ["error", "Failed to authenticate. API Error: 401 OAuth access token is invalid."],
  ],
  "04-auth-not-logged-in.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · default · 0 tools"],
    ["error", "Not logged in · Please run /login (authentication_failed)"],
    ["error", "Not logged in · Please run /login"],
  ],
  "05-stdin-inject.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · bypassPermissions · 1 tool"],
    ["run", "Run sleep 4; echo slept"],
    [
      "steer",
      "Additional instruction: when you finish, end your final reply with the word BANANA.",
    ],
    ["note", 'It printed "slept" after sleeping for 4 seconds. BANANA'],
    ["result", "Done in 2 turns"],
    ["note", "CHERRY"],
    ["result", "Done in 1 turn"],
  ],
  "05-stdin-interrupt.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · bypassPermissions · 1 tool"],
    ["run", "Run sleep 30; echo late"],
    ["error", /^Bash failed: Blocked: sleep 30 followed by: echo late\./],
    ["note", "[Request interrupted by user]"],
    ["error", "Ended: aborted_streaming"],
    ["note", "PLUM"],
    ["result", "Done in 1 turn"],
  ],
  "06-mcp-http.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · default · 4 tools"],
    ["read", "mcp__mastermind__get_summary"],
    ["read", "Read README.md"],
    ["note", 'The secret word is **KUMQUAT** and the README text is "This repo has a README".'],
    ["result", "Done in 3 turns"],
  ],
  "07-accept-edits-denied.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · acceptEdits · 30 tools"],
    ["run", `Run node -e "require('fs').writeFileSync('n.txt','x')"`],
    ["error", "Denied Bash: This command requires approval"],
    ["note", /^The command requires approval from you/],
    ["result", "Done in 2 turns"],
  ],
  "07-dont-ask-denied.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · dontAsk · 30 tools"],
    ["run", `Run node -e "require('fs').writeFileSync('n.txt','x')"`],
    ["error", /^Denied Bash: Permission to use Bash has been denied because .* don't ask mode/],
    ["read", "Read Makefile"],
    ["edit", "Edit Makefile"],
    ["run", "Run make test"],
    ["note", "**Step 1 (node write):** Permission denied — don't ask mode"],
    ["result", "Done in 5 turns"],
  ],
  "07-auto-unavailable-for-model.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · default · 30 tools"],
    ["run", "Run touch made-by-bash.txt"],
    ["error", /^Denied Bash: touch in '.*made-by-bash.txt' needs approval\./],
    ["read", "Read Makefile"],
    ["edit", "Edit Makefile"],
    ["error", /^Denied Edit: Claude requested permissions to write to .*Makefile/],
    ["run", "Run make test"],
    ["note", "Step 1: Failed — touch needs approval."],
    ["result", "Done in 5 turns"],
  ],
  "08-attribution-default.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · bypassPermissions · 29 tools"],
    ["note", "I'll read a.txt first, then append 'b' and commit the change."],
    ["read", "Read a.txt"],
    ["edit", "Edit a.txt"],
    ["run", `Run git add a.txt && git commit -m "$(cat <<'EOF'`],
    ["commit", 'Commit "Add b Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>"'],
    ["note", /^Done\. I've appended 'b' to a\.txt/],
    ["result", "Done in 4 turns"],
  ],
  "10-path-guard-hook.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · bypassPermissions · 30 tools"],
    ["note", "I'll execute each write operation separately and report the outcomes."],
    ["edit", "Write /private/tmp/mm-spikes/outside2/guarded.txt"],
    [
      "error",
      /^Write failed: PreToolUse:Write hook error: mastermind: .* outside this task's worktree$/,
    ],
    ["edit", "Write /tmp/mm-spikes/repo10/../outside2/guarded2.txt"],
    [
      "error",
      "Write failed: mastermind: /tmp/mm-spikes/outside2/guarded2.txt is outside this task's worktree",
    ],
    ["edit", "Write inside-write.txt"],
    ["note", "## Results"],
    ["result", "Done in 4 turns"],
  ],
  "10-sandbox-apply-failed.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · bypassPermissions · 30 tools"],
    ["run", "Run echo hi > inside2.txt"],
    ["error", "Bash failed: Exit code 71: sandbox-exec: sandbox_apply: Operation not permitted"],
    ["note", /^The command failed due to a sandbox restriction\./],
    ["result", "Done in 2 turns"],
  ],
  "10-sandbox-bypass.jsonl": [
    ["start", "claude-haiku-4-5-20251001 · bypassPermissions · 30 tools"],
    ["note", "I'll execute each sandbox test step exactly once, continuing even if steps fail."],
    ["run", "Run echo x > /private/tmp/mm-spikes/outside/bash.txt"],
    [
      "error",
      "Bash failed: Exit code 1: (eval):1: operation not permitted: /private/tmp/mm-spikes/outside/bash.txt",
    ],
    ["run", 'Run curl -sS -m 8 -o /dev/null -w "%{http_code}" https://example.com'],
    [
      "error",
      "Bash failed: sandbox: deny network-outbound example.com:443 (host is not on the allow list)",
    ],
    ["run", 'Run curl -sS -m 8 -o /dev/null -w "%{http_code}" https://registry.npmjs.org/'],
    ["edit", "Write /private/tmp/mm-spikes/outside/write-denied.txt"],
    ["error", "Write failed: File is in a directory that is denied by your permission settings."],
    ["edit", "Write /private/tmp/mm-spikes/outside2/write-nodeny.txt"],
    ["run", "Run echo ok > inside.txt"],
    ["note", "## Sandbox Test Results"],
    ["result", "Done in 7 turns"],
  ],
};

const noiseLineTypes = [
  "system/thinking_tokens",
  "system/status",
  "system/task_started",
  "system/task_notification",
  "control_response",
];

describe("stream parser on the recorded samples", () => {
  test("every recorded stream sample has an expected table", () => {
    const samples = readdirSync(samplesDir).filter((name) => name.endsWith(".jsonl"));
    expect(samples.sort()).toEqual(Object.keys(expectedBySample).sort());
  });

  test.each(Object.entries(expectedBySample))(
    "%s yields the expected stored events",
    (name, rows) => {
      const expected = rows.map(([type, summary]) => {
        const matcher: unknown =
          typeof summary === "string" ? summary : expect.stringMatching(summary);
        return [type, matcher];
      });
      expect(storedRows(parseAll(sampleLines(name)))).toEqual(expected);
    },
  );

  test.each(Object.keys(expectedBySample))(
    "%s has only recognised lines or known noise",
    (name) => {
      const unrecognised = parseAll(sampleLines(name)).flatMap(({ details }) =>
        details.line === "other" && !noiseLineTypes.includes(details.lineType ?? "")
          ? [details.lineType]
          : [],
      );
      expect(unrecognised).toEqual([]);
    },
  );

  test("a worker run carries session id, paths, commands, the commit and usage in details", () => {
    const events = parseAll(sampleLines("01-worker-run.jsonl"));
    const details = events.map((event) => event.details);
    const sessionId = "7eb0b0ad-7be4-4bd5-a56d-8398ba24f319";

    expect(details).toContainEqual(
      expect.objectContaining({
        line: "tool_use",
        sessionId,
        toolName: "Edit",
        filePath: "/private/tmp/mm-spikes/repo1/hello.py",
      }),
    );
    expect(details).toContainEqual(
      expect.objectContaining({
        line: "tool_result",
        toolName: "Bash",
        command: 'git add -A && git commit -m "Say goodbye"',
        commit: { sha: "2cbbe84", branch: "main", subject: "Say goodbye" },
      }),
    );
    expect(lastResult(events)?.details).toEqual(
      expect.objectContaining({
        line: "result",
        sessionId,
        isError: false,
        resultText: "done",
        numTurns: 5,
        usage: {
          inputTokens: 42,
          outputTokens: 711,
          cacheReadInputTokens: 104612,
          cacheCreationInputTokens: 9553,
        },
      }),
    );
  });

  test("partial text deltas add up to the final assistant text", () => {
    const events = parseAll(sampleLines("01-partial-messages.jsonl"));
    const streamed = events
      .map(({ details }) => (details.line === "partial" ? (details.textDelta ?? "") : ""))
      .join("");
    const final = events.findLast(
      ({ details }) => details.line === "assistant" && details.text !== null,
    );
    expect(final?.details).toEqual(expect.objectContaining({ text: streamed }));
    expect(streamed).toMatch(/^The README states/);
  });

  test("rate limit events become usage details with an ISO reset time and are not stored", () => {
    const [first] = parseAll(sampleLines("03-rate-limit-events.jsonl"));
    expect(first).toMatchObject({
      type: "note",
      stored: false,
      details: {
        line: "rate_limit",
        rateLimit: { status: "allowed", resetsAt: "2026-10-06T09:10:00.000Z", window: "five_hour" },
      },
    });
  });

  test("a rejected rate limit with an unrepresentable reset time keeps its status", () => {
    expect(createStreamParser().parseLine(rateLimit("rejected", 1e20))).toMatchObject({
      details: { line: "rate_limit", rateLimit: { status: "rejected", resetsAt: null } },
    });
  });
});

describe("stream parser on malformed, unknown and synthetic lines", () => {
  test.each([
    ["not JSON", "{oops", null],
    ["an empty line", "", null],
    ["a JSON array", "[1, 2]", null],
    ["an unknown type", json({ type: "brand_new", value: 1 }), "brand_new"],
    [
      "an unknown system subtype",
      json({ type: "system", subtype: "brand_new" }),
      "system/brand_new",
    ],
    ["a known type with a broken shape", json({ type: "assistant", message: 42 }), "assistant"],
  ])("%s becomes an unstored note", (_name, line, lineType) => {
    expect(createStreamParser().parseLine(line)).toMatchObject({
      type: "note",
      stored: false,
      payload: line,
      details: { line: "other", lineType },
    });
  });

  test("unknown fields and unknown content blocks are tolerated", () => {
    const line = json({
      type: "assistant",
      future_field: { nested: true },
      message: {
        content: [
          { type: "server_tool_use", id: "x" },
          { type: "text", text: "Looking at the parser\nsecond line" },
        ],
      },
    });
    expect(createStreamParser().parseLine(line)).toMatchObject({
      type: "note",
      summary: "Looking at the parser",
      stored: true,
    });
  });

  test.each([
    ["a bare result line", { type: "result" }, "error", "Ended: error"],
    [
      "a result with wrongly typed fields",
      { type: "result", is_error: false, num_turns: "5" },
      "result",
      "Done in 0 turns",
    ],
    [
      "an interrupted result",
      {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
      },
      "error",
      "Ended: aborted_streaming",
    ],
  ])("%s is still recognised as the end of the turn", (_name, line, type, summary) => {
    expect(createStreamParser().parseLine(json(line))).toMatchObject({
      type,
      summary,
      details: { line: "result" },
    });
  });

  test("paths are shown relative to the session cwd", () => {
    const events = parseAll([
      json({
        type: "system",
        subtype: "init",
        cwd: "/work/linux",
        model: "opus",
        permissionMode: "bypassPermissions",
        tools: ["Edit"],
        mcp_servers: [],
      }),
      toolUse("t1", "Edit", { file_path: "/work/linux/kernel/fs/ext2/inode.rs" }),
      toolUse("t2", "Grep", { pattern: "superblock" }),
      toolUse("t3", "Read", { file_path: "/elsewhere/notes.md" }),
    ]);
    expect(storedRows(events)).toEqual([
      ["start", "opus · bypassPermissions · 1 tool"],
      ["edit", "Edit kernel/fs/ext2/inode.rs"],
      ["read", 'Grep "superblock"'],
      ["read", "Read /elsewhere/notes.md"],
    ]);
  });

  test.each([
    {
      name: "a quiet commit reported by the CLI takes its subject from the command",
      command: 'git commit -q -m "ext2: read superblock"',
      lines: [
        toolResult("t", "", {
          toolUseResult: {
            stdout: "",
            gitOperation: { commit: { sha: "abc1234", branch: "task/ext2" } },
          },
        }),
      ],
      expected: ["commit", 'Commit "ext2: read superblock"'],
    },
    {
      name: "a commit without the CLI's report is read from git's output",
      command: "git -c user.name=x commit -F msg.txt",
      lines: [
        toolResult("t", "[task/ext2 (root-commit) 9f8e7d6] ext2: read superblock\n 1 file changed"),
      ],
      expected: ["commit", 'Commit "ext2: read superblock"'],
    },
    {
      name: "a failed commit is an error",
      command: 'git commit -m "wip"',
      lines: [
        toolResult("t", "Exit code 1\nnothing to commit, working tree clean", { isError: true }),
      ],
      expected: ["error", "Bash failed: Exit code 1: nothing to commit, working tree clean"],
    },
    {
      name: "output that only looks like a commit is not one",
      command: "cat log.txt",
      lines: [toolResult("t", "[main 1234567] not a commit")],
      expected: null,
    },
    {
      name: "a commit only the CLI's git state change reports is still a commit",
      command: "make release",
      lines: [
        json({ type: "system", subtype: "vcs_state_changed", kind: "commit", branch: "main" }),
        toolResult("t", "released"),
      ],
      expected: ["commit", "Commit"],
    },
  ])("$name", ({ command, lines, expected }) => {
    const events = parseAll([toolUse("t", "Bash", { command }), ...lines]);
    expect(storedRows(events)).toEqual([
      ["run", `Run ${command}`],
      ...(expected === null ? [] : [expected]),
    ]);
  });
});

describe("classifyExit", () => {
  const usageLimitTexts = [
    "You've hit your limit · resets 3pm (UTC)",
    "Claude AI usage limit reached",
    "You have reached your weekly usage limit",
    "You're out of extra usage",
    "You've hit your monthly spend limit",
  ];
  const authTexts = [
    "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
    "Not logged in · Please run /login",
    "OAuth token has expired",
    "OAuth token has been revoked",
    "Invalid bearer token",
    "Login expired · Please run /login",
    "OAuth token revoked · Please run /login",
  ];

  function classify(lines: readonly string[], exitCode: number | null, stderr = ""): ExitOutcome {
    const events = parseAll(lines);
    return classifyExit(lastResult(events), exitCode, stderr, events);
  }

  test.each([
    ["01-worker-run.jsonl", 0, { status: "succeeded" }],
    [
      "04-auth-invalid-token.jsonl",
      1,
      {
        status: "auth_failed",
        reason:
          "Failed to authenticate. API Error: 401 OAuth access token is invalid.; claude exited with code 1",
      },
    ],
    [
      "04-auth-not-logged-in.jsonl",
      1,
      {
        status: "auth_failed",
        reason: "Not logged in · Please run /login; claude exited with code 1",
      },
    ],
  ])("recorded sample %s exiting %i is %o", (name, exitCode, outcome) => {
    expect(classify(sampleLines(name), exitCode)).toEqual(outcome);
  });

  test.each(usageLimitTexts)("an error result saying %j is a usage limit", (text) => {
    expect(classify([errorResult(text)], 1)).toEqual({ status: "rate_limited" });
  });

  test.each(authTexts)("an error result saying %j is an auth failure", (text) => {
    expect(classify([errorResult(text)], 1)).toMatchObject({ status: "auth_failed" });
  });

  test.each([
    {
      name: "a rejected rate limit event gives the resume time",
      lines: [
        rateLimit("allowed", 1791270000),
        rateLimit("rejected", 1791277800),
        syntheticError("rate_limit", "You've hit your limit · resets 3pm (UTC)"),
        errorResult("You've hit your limit · resets 3pm (UTC)", 429),
      ],
      exitCode: 1,
      outcome: { status: "rate_limited", resetAt: "2026-10-06T09:10:00.000Z" },
    },
    {
      name: "a billing error from the API is a usage limit",
      lines: [syntheticError("billing_error", "API Error"), errorResult("API Error")],
      exitCode: 1,
      outcome: { status: "rate_limited" },
    },
    {
      name: "HTTP 429 is a usage limit",
      lines: [errorResult("API Error: 429", 429)],
      exitCode: 1,
      outcome: { status: "rate_limited" },
    },
    {
      name: "an org that is not allowed is an auth failure",
      lines: [
        syntheticError("oauth_org_not_allowed", "Your organization is not allowed"),
        errorResult("Your organization is not allowed"),
      ],
      exitCode: 1,
      outcome: {
        status: "auth_failed",
        reason: "Your organization is not allowed; claude exited with code 1",
      },
    },
    {
      name: "a refresh race is not an auth failure",
      lines: [
        errorResult(
          "Could not refresh your login because another Claude Code process is refreshing it",
        ),
      ],
      exitCode: 1,
      outcome: {
        status: "failed",
        reason:
          "Could not refresh your login because another Claude Code process is refreshing it; claude exited with code 1",
      },
    },
    {
      name: "a deterministic CLI error without a result",
      lines: [],
      exitCode: 1,
      stderr: "Error: Session ID 7eb0b0ad is already in use.\n",
      outcome: {
        status: "failed",
        reason:
          "claude ended without a result; claude exited with code 1; Error: Session ID 7eb0b0ad is already in use.",
      },
    },
    {
      name: "a process killed by a signal",
      lines: [],
      exitCode: null,
      outcome: {
        status: "failed",
        reason: "claude ended without a result; claude was killed by a signal",
      },
    },
    {
      name: "an interrupted turn",
      lines: [
        resultLine({
          subtype: "error_during_execution",
          is_error: true,
          terminal_reason: "aborted_streaming",
        }),
      ],
      exitCode: 0,
      outcome: { status: "failed", reason: "claude ended: aborted_streaming" },
    },
    {
      name: "a clean result with a non-zero exit",
      lines: [resultLine({ result: "Fixed the usage limit banner" })],
      exitCode: 1,
      outcome: { status: "failed", reason: "claude exited with code 1" },
    },
    {
      name: "a successful run that talks about limits",
      lines: [
        rateLimit("allowed_warning", 1791277800),
        resultLine({ result: "You've hit your limit text is now translated" }),
      ],
      exitCode: 0,
      outcome: { status: "succeeded" },
    },
  ])("$name", ({ lines, exitCode, stderr, outcome }) => {
    expect(classify(lines, exitCode, stderr)).toEqual(outcome);
  });
});

describe("readStructuredOutput", () => {
  const verdictSchema = z.object({ flaky: z.boolean(), reason: z.string() });

  test("returns the validated object from the --json-schema sample", () => {
    const result = lastResult(parseAll(sampleLines("02-json-schema.jsonl")));
    const verdict = readStructuredOutput(result, verdictSchema);
    expect(verdict.flaky).toBe(true);
    expect(verdict.reason).toMatch(/^A test that fails intermittently/);
  });

  test.each([
    ["no-result", []],
    ["error-result", [errorResult("Not logged in · Please run /login")]],
    ["missing", [resultLine({ result: '{"flaky":true,"reason":"text only"}' })]],
    ["invalid", [resultLine({ structured_output: { flaky: "yes" } })]],
  ])("fails as %s without scraping the result text", (reason, lines) => {
    const result = lastResult(parseAll(lines));
    expect(() => readStructuredOutput(result, verdictSchema)).toThrow(
      expect.objectContaining({ name: StructuredOutputError.name, reason }),
    );
  });
});
