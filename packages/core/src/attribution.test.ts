import { describe, expect, it } from "vitest";
import { findAttribution, stripAttribution } from "./attribution.js";

describe("attribution scanner and rewriter", () => {
  it.each([
    {
      name: "a Co-Authored-By trailer naming a Claude model",
      text: "Add the parser\n\nCo-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>",
      stripped: "Add the parser",
    },
    {
      name: "a lowercase co-authored-by trailer with Anthropic's address only",
      text: "Fix it\n\nco-authored-by: Assistant <noreply@anthropic.com>\n",
      stripped: "Fix it",
    },
    {
      name: "the robot footer with its link",
      text: "Summary.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-authored-by: Claude <noreply@anthropic.com>",
      stripped: "Summary.",
    },
    {
      name: "a plain 'Generated with Claude Code' line",
      text: "Summary.\nGENERATED WITH CLAUDE CODE",
      stripped: "Summary.",
    },
    {
      name: "a Claude-Session trailer and a session link",
      text: "Work\n\nClaude-Session: 3f1c\nclaude-code-session-id: 3f1c\nhttps://claude.ai/code/session_01AbC",
      stripped: "Work",
    },
    {
      name: "a co-author whose name only starts with Claude",
      text: "Work\n\nCo-Authored-By: ClaudeAI <bot@example.com>\nCo-Authored-By: Claude3 Opus",
      stripped: "Work",
    },
    {
      name: "other -by trailers that name Claude",
      text: "Work\n\nAssisted-by: Claude Code\nSigned-off-by: Ada Lovelace <ada@example.com>",
      stripped: "Work\n\nSigned-off-by: Ada Lovelace <ada@example.com>",
    },
    {
      name: "attribution in the middle, leaving one blank line",
      text: "First\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n\nSecond",
      stripped: "First\n\nSecond",
    },
  ])("finds and strips $name", ({ text, stripped }) => {
    expect(findAttribution(text).length).toBeGreaterThan(0);
    expect(stripAttribution(text)).toBe(stripped);
    expect(findAttribution(stripAttribution(text))).toEqual([]);
  });

  it.each([
    "Teach the parser about Claude's stream-json lines",
    "Co-Authored-By: Ada Lovelace <ada@example.com>",
    "Generated the fixtures with make samples",
    "claude-cli: pass the session id through",
    "Session handling for anthropic-style ids is unchanged",
  ])("leaves %j alone", (text) => {
    expect(findAttribution(text)).toEqual([]);
    expect(stripAttribution(text)).toBe(text);
  });

  it("reports the line number and text of every match", () => {
    const text =
      "Subject\n\nBody\n\nClaude-Session: abc\nCo-Authored-By: Claude <noreply@anthropic.com>";
    expect(findAttribution(text)).toEqual([
      { line: 5, text: "Claude-Session: abc" },
      { line: 6, text: "Co-Authored-By: Claude <noreply@anthropic.com>" },
    ]);
  });
});
