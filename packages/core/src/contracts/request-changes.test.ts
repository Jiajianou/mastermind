import { describe, expect, it } from "vitest";
import { buildChangeRequest, failingTestLogLines } from "./request-changes.js";
import type { ChangeRequestParts, CommentNote } from "./request-changes.js";

const nothing: ChangeRequestParts = {
  instruction: "",
  comments: [],
  findings: [],
  failingTest: null,
};

const opening = "The owner reviewed this work and asks for the changes below.";
const closing =
  "Make these changes, keep the rest of the work as it is, run the acceptance command until it passes, and commit. Then update `.mastermind-result.md`.";

const comment = (note: Partial<CommentNote>): CommentNote => ({
  file: "src/app.ts",
  lineStart: 1,
  lineEnd: 1,
  excerpt: "",
  text: "Explain this.",
  ...note,
});

describe("buildChangeRequest", () => {
  it("builds one message from the instruction, the comments, the findings and the failing check", () => {
    const message = buildChangeRequest({
      instruction: "  Use a map instead of the switch.  ",
      comments: [
        comment({
          lineStart: 4,
          lineEnd: 5,
          excerpt: "switch (kind) {\n  case 1:\n",
          text: " Too long. ",
        }),
      ],
      findings: [
        { file: "src/app.ts", line: 9, severity: "serious", text: "Off by one." },
        { file: "README.md", line: null, severity: "minor", text: "Typo in the title." },
      ],
      failingTest: {
        check: { kind: "acceptance", summary: "make check exited with code 2" },
        log: "running\nexpected 3, got 2\n\n",
      },
    });

    expect(message).toBe(
      [
        opening,
        "Use a map instead of the switch.",
        "## Comments on the code",
        "### src/app.ts, lines 4–5\n\n```text\nswitch (kind) {\n  case 1:\n```\n\nToo long.",
        "## Reviewer findings",
        "- serious · src/app.ts:9: Off by one.\n- minor · README.md: Typo in the title.",
        "## Failing check: Acceptance",
        "It failed: make check exited with code 2. The last lines of its log:",
        "```text\nrunning\nexpected 3, got 2\n```",
        closing,
      ].join("\n\n"),
    );
  });

  it.each<{
    name: string;
    parts: ChangeRequestParts;
    includes?: string[];
    excludes?: string[];
    ordered?: string[];
  }>([
    {
      name: "a blank instruction is left out",
      parts: { ...nothing, comments: [comment({ text: "Why?" })] },
      includes: ["### src/app.ts, line 1\n\nWhy?"],
      excludes: ["\n\n\n"],
    },
    {
      name: "comments are ordered by file and line, whatever order they were picked in",
      parts: {
        ...nothing,
        comments: [
          comment({ file: "src/b.ts", lineStart: 2, lineEnd: 2, text: "third" }),
          comment({ file: "src/a.ts", lineStart: 9, lineEnd: 9, text: "second" }),
          comment({ file: "src/a.ts", lineStart: 3, lineEnd: 3, text: "first" }),
        ],
      },
      ordered: ["first", "second", "third"],
    },
    {
      name: "an excerpt that contains a fence gets a longer one",
      parts: {
        ...nothing,
        comments: [comment({ excerpt: "```ts\nconst a = 1;\n```" })],
      },
      includes: ["````text\n```ts\nconst a = 1;\n```\n````"],
    },
    {
      name: "a failing check without a summary or output still says what failed",
      parts: {
        ...nothing,
        failingTest: { check: { kind: "suite", summary: null }, log: "" },
      },
      includes: [
        "## Failing check: Test suite",
        "It failed. The last lines of its log:",
        "```text\n(no output)\n```",
      ],
    },
  ])("$name", ({ parts, includes = [], excludes = [], ordered = [] }) => {
    const message = buildChangeRequest(parts);
    for (const text of includes) expect(message).toContain(text);
    for (const text of excludes) expect(message).not.toContain(text);
    const positions = ordered.map((text) => message.indexOf(text));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(positions.every((position) => position >= 0)).toBe(true);
  });

  it("keeps only the last lines of a long failing log", () => {
    const log = Array.from({ length: 200 }, (_, index) => `line ${String(index + 1)}`).join("\n");
    const message = buildChangeRequest({
      ...nothing,
      failingTest: { check: { kind: "build", summary: "make exited with code 2" }, log },
    });

    const fence = message.slice(message.indexOf("```text\n") + "```text\n".length);
    const kept = fence.slice(0, fence.indexOf("\n```")).split("\n");
    expect(kept).toHaveLength(failingTestLogLines);
    expect(kept[0]).toBe(`line ${String(200 - failingTestLogLines + 1)}`);
    expect(kept.at(-1)).toBe("line 200");
  });
});
