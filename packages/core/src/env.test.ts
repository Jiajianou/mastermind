import { describe, expect, it } from "vitest";
import { cleanEnv } from "./env.js";

describe("cleanEnv", () => {
  it.each([
    { name: "ANTHROPIC_API_KEY", value: "sk-ant-api03-x", kept: false },
    { name: "ANTHROPIC_AUTH_TOKEN", value: "token", kept: false },
    { name: "ANTHROPIC_BASE_URL", value: "https://proxy.example", kept: false },
    { name: "ANTHROPIC_BEDROCK_BASE_URL", value: "https://bedrock.example", kept: false },
    { name: "ANTHROPIC_VERTEX_PROJECT_ID", value: "project", kept: false },
    { name: "ANTHROPIC_FOUNDRY_RESOURCE", value: "resource", kept: false },
    { name: "CLAUDE_CODE_USE_BEDROCK", value: "1", kept: false },
    { name: "CLAUDE_CODE_USE_VERTEX", value: "1", kept: false },
    { name: "CLAUDE_CODE_USE_FOUNDRY", value: "1", kept: false },
    { name: "CLAUDECODE", value: "1", kept: false },
    { name: "CLAUDE_CODE_ENTRYPOINT", value: "cli", kept: false },
    { name: "CLAUDE_CODE_SESSION_ID", value: "id", kept: false },
    { name: "CLAUDE_CODE_CHILD_SESSION", value: "1", kept: false },
    { name: "CLAUDE_CODE_SESSION_ATTENDED", value: "1", kept: false },
    { name: "CLAUDE_CODE_MESSAGING_SOCKET", value: "/tmp/socket", kept: false },
    { name: "CLAUDE_CODE_MESSAGING_TOKEN", value: "secret", kept: false },
    { name: "CLAUDE_CODE_EXECPATH", value: "/usr/local/bin/claude", kept: false },
    { name: "CLAUDE_PID", value: "123", kept: false },
    { name: "CLAUDE_EFFORT", value: "high", kept: false },
    { name: "AI_AGENT", value: "claude-code", kept: false },
    { name: "CLAUDE_CONFIG_DIR", value: "", kept: false },
    { name: "CLAUDE_CONFIG_DIR", value: "/home/owner/.claude-work", kept: true },
    { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "sk-ant-oat01-x", kept: true },
    { name: "CLAUDE_CODE_MAX_OUTPUT_TOKENS", value: "32000", kept: true },
    { name: "GIT_DIR", value: "/home/owner/repo/.git", kept: false },
    { name: "GIT_WORK_TREE", value: "/home/owner/repo", kept: false },
    { name: "GIT_INDEX_FILE", value: "/home/owner/repo/.git/index", kept: false },
    { name: "GIT_EDITOR", value: "true", kept: true },
    { name: "PATH", value: "/usr/bin:/bin", kept: true },
    { name: "HOME", value: "/home/owner", kept: true },
  ])("$name=$value is kept: $kept", ({ name, value, kept }) => {
    const cleaned = cleanEnv({ [name]: value, LANG: "en_US.UTF-8" });

    expect(cleaned).toEqual(
      kept ? { [name]: value, LANG: "en_US.UTF-8" } : { LANG: "en_US.UTF-8" },
    );
  });

  it("drops unset variables and leaves its input untouched", () => {
    const env = { PATH: "/bin", ANTHROPIC_API_KEY: "key", UNSET: undefined };

    expect(cleanEnv(env)).toEqual({ PATH: "/bin" });
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "key", UNSET: undefined });
  });
});
