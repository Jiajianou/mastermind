import { checkAuth, login, logout } from "@mastermind/core/auth";
import type { AuthVerdict } from "@mastermind/core/auth";
import { createClaudeCli } from "@mastermind/core/claude";
import type { ClaudeCli } from "@mastermind/core/claude";
import { createProcessRegistry } from "@mastermind/core/procs";
import { describe, expect, it } from "vitest";
import type { AccountKind } from "../support/fake-claude.js";
import { isolatedEnv } from "../support/isolated-env.js";
import type { IsolatedEnvOptions } from "../support/isolated-env.js";

async function claudeFor(options: IsolatedEnvOptions) {
  const env = await isolatedEnv(options);
  const cli: ClaudeCli = createClaudeCli({ registry: createProcessRegistry(), env: env.env });
  return { env, cli };
}

const ownerEmail = "owner@example.com";

const accounts: { account: AccountKind; verdict: AuthVerdict }[] = [
  { account: "max", verdict: { kind: "accepted", email: ownerEmail, plan: "max" } },
  { account: "pro", verdict: { kind: "accepted", email: ownerEmail, plan: "pro" } },
  { account: "signed-out", verdict: { kind: "not-signed-in" } },
  { account: "free", verdict: { kind: "wrong-kind", reason: "plan", plan: "free" } },
  { account: "team", verdict: { kind: "wrong-kind", reason: "plan", plan: "team" } },
  { account: "enterprise", verdict: { kind: "wrong-kind", reason: "plan", plan: "enterprise" } },
  { account: "console", verdict: { kind: "wrong-kind", reason: "api-billing" } },
  { account: "api-key", verdict: { kind: "wrong-kind", reason: "api-billing" } },
  { account: "api-key-helper", verdict: { kind: "wrong-kind", reason: "api-key-helper" } },
  { account: "oauth-token", verdict: { kind: "wrong-kind", reason: "unverified-token" } },
  { account: "bedrock", verdict: { kind: "wrong-kind", reason: "provider", provider: "bedrock" } },
  { account: "vertex", verdict: { kind: "wrong-kind", reason: "provider", provider: "vertex" } },
];

describe("auth gate through claude auth status", () => {
  it.each(accounts)("classifies a $account account", async ({ account, verdict }) => {
    const { cli } = await claudeFor({ account });

    expect(await checkAuth(cli)).toEqual(verdict);
  });

  it("ignores API keys and provider switches in the owner's environment", async () => {
    const { env, cli } = await claudeFor({
      account: "max",
      env: {
        ANTHROPIC_API_KEY: "sk-ant-api03-owner",
        ANTHROPIC_AUTH_TOKEN: "token",
        CLAUDE_CODE_USE_BEDROCK: "1",
        CLAUDE_CODE_USE_VERTEX: "1",
        CLAUDECODE: "1",
        CLAUDE_CODE_MESSAGING_TOKEN: "parent-session",
      },
    });

    expect(await checkAuth(cli)).toEqual({ kind: "accepted", email: ownerEmail, plan: "max" });
    const [invocation] = await env.invocations();
    expect(Object.keys(invocation?.env ?? {}).sort()).toEqual(["CLAUDE_CONFIG_DIR", "HOME"]);
  });

  it("keeps CLAUDE_CODE_OAUTH_TOKEN, which the gate refuses until it shows a plan", async () => {
    const { cli } = await claudeFor({
      account: "max",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-owner" },
    });

    expect(await checkAuth(cli)).toEqual({ kind: "wrong-kind", reason: "unverified-token" });
  });

  it("hands off to claude auth login --claudeai and claude auth logout", async () => {
    const { env, cli } = await claudeFor({
      account: "signed-out",
      env: { FAKE_CLAUDE_LOGIN_ACCOUNT: "pro" },
    });

    expect(await login(cli)).toEqual({ kind: "exited", code: 0 });
    expect(await checkAuth(cli)).toEqual({ kind: "accepted", email: ownerEmail, plan: "pro" });
    expect(await logout(cli)).toEqual({ kind: "exited", code: 0 });
    expect(await checkAuth(cli)).toEqual({ kind: "not-signed-in" });

    const argvs = (await env.invocations()).map((invocation) => invocation.argv);
    expect(argvs).toContainEqual(["auth", "login", "--claudeai"]);
    expect(argvs).toContainEqual(["auth", "logout"]);
  });

  it("reports a failed login through its exit result", async () => {
    const { cli } = await claudeFor({
      account: "signed-out",
      env: { FAKE_CLAUDE_LOGIN_FAIL: "1" },
    });

    expect(await login(cli)).toEqual({ kind: "exited", code: 1 });
    expect(await checkAuth(cli)).toEqual({ kind: "not-signed-in" });
  });
});
