import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { authStatusSchema, classifyAuth, describeAuth } from "./auth.js";
import type { AuthVerdict } from "./auth.js";

function recordedStatus(name: string): unknown {
  const url = new URL(
    `../../../test/fixtures/claude-samples/04-auth-status-${name}.json`,
    import.meta.url,
  );
  return JSON.parse(readFileSync(url, "utf8"));
}

const subscription = (subscriptionType: string | null) => ({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "owner@example.com",
  subscriptionType,
});

const cases: { account: string; status: unknown; verdict: AuthVerdict; text: string }[] = [
  {
    account: "recorded Max sign-in",
    status: recordedStatus("signed-in"),
    verdict: { kind: "accepted", email: "owner@example.com", plan: "max" },
    text: "✓ Signed in as owner@example.com (Max)",
  },
  {
    account: "Pro",
    status: subscription("pro"),
    verdict: { kind: "accepted", email: "owner@example.com", plan: "pro" },
    text: "✓ Signed in as owner@example.com (Pro)",
  },
  {
    account: "recorded signed-out state",
    status: recordedStatus("logged-out"),
    verdict: { kind: "not-signed-in" },
    text: "Mastermind needs a Claude Pro or Max account. Press Enter to sign in in your browser · Esc to quit",
  },
  {
    account: "free plan",
    status: subscription("free"),
    verdict: { kind: "wrong-kind", reason: "plan", plan: "free" },
    text: "This account uses the free plan. Mastermind supports Claude Pro and Max subscriptions only.",
  },
  {
    account: "Team plan",
    status: subscription("team"),
    verdict: { kind: "wrong-kind", reason: "plan", plan: "team" },
    text: "This account uses a Team plan. Mastermind supports Claude Pro and Max subscriptions only.",
  },
  {
    account: "Enterprise plan",
    status: subscription("enterprise"),
    verdict: { kind: "wrong-kind", reason: "plan", plan: "enterprise" },
    text: "This account uses an Enterprise plan. Mastermind supports Claude Pro and Max subscriptions only.",
  },
  {
    account: "claude.ai sign-in without a plan",
    status: subscription(null),
    verdict: { kind: "wrong-kind", reason: "plan", plan: null },
    text: "This account uses no Claude subscription. Mastermind supports Claude Pro and Max subscriptions only.",
  },
  {
    account: "Console account",
    status: { loggedIn: true, authMethod: "console", apiProvider: "firstParty", email: "a@b.c" },
    verdict: { kind: "wrong-kind", reason: "api-billing" },
    text: "This account uses API billing. Mastermind supports Claude Pro and Max subscriptions only.",
  },
  {
    account: "API key",
    status: {
      loggedIn: true,
      authMethod: "api_key",
      apiProvider: "firstParty",
      apiKeySource: "ANTHROPIC_API_KEY",
    },
    verdict: { kind: "wrong-kind", reason: "api-billing" },
    text: "This account uses API billing. Mastermind supports Claude Pro and Max subscriptions only.",
  },
  {
    account: "apiKeyHelper",
    status: {
      loggedIn: true,
      authMethod: "api_key",
      apiProvider: "firstParty",
      apiKeySource: "apiKeyHelper",
    },
    verdict: { kind: "wrong-kind", reason: "api-key-helper" },
    text: "This account uses an apiKeyHelper from your Claude settings, which bills through the API. Mastermind supports Claude Pro and Max subscriptions only.",
  },
  {
    account: "Bedrock",
    status: { loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" },
    verdict: { kind: "wrong-kind", reason: "provider", provider: "bedrock" },
    text: "This account uses Amazon Bedrock. Mastermind supports Claude Pro and Max subscriptions only.",
  },
  {
    account: "Vertex",
    status: { loggedIn: true, authMethod: "third_party", apiProvider: "vertex" },
    verdict: { kind: "wrong-kind", reason: "provider", provider: "vertex" },
    text: "This account uses Google Vertex AI. Mastermind supports Claude Pro and Max subscriptions only.",
  },
  {
    account: "Max subscription routed through Foundry",
    status: { ...subscription("max"), apiProvider: "foundry" },
    verdict: { kind: "wrong-kind", reason: "provider", provider: "foundry" },
    text: "This account uses Microsoft Foundry. Mastermind supports Claude Pro and Max subscriptions only.",
  },
  {
    account: "recorded CLAUDE_CODE_OAUTH_TOKEN without a plan",
    status: recordedStatus("oauth-token"),
    verdict: { kind: "wrong-kind", reason: "unverified-token" },
    text: "This account uses CLAUDE_CODE_OAUTH_TOKEN, which does not show a Pro or Max plan (unset it to use your normal sign-in). Mastermind supports Claude Pro and Max subscriptions only.",
  },
  {
    account: "CLAUDE_CODE_OAUTH_TOKEN reporting Max",
    status: {
      loggedIn: true,
      authMethod: "oauth_token",
      apiProvider: "firstParty",
      subscriptionType: "max",
    },
    verdict: { kind: "accepted", email: null, plan: "max" },
    text: "✓ Signed in (Max)",
  },
  {
    account: "unknown sign-in method",
    status: { ...subscription("max"), authMethod: "sso_magic" },
    verdict: { kind: "wrong-kind", reason: "auth-method", method: "sso_magic" },
    text: 'This account uses the "sso_magic" sign-in method. Mastermind supports Claude Pro and Max subscriptions only.',
  },
];

describe("classifyAuth", () => {
  it.each(cases)("$account → $verdict.kind", ({ status, verdict, text }) => {
    const result = classifyAuth(authStatusSchema.parse(status));

    expect(result).toEqual(verdict);
    expect(describeAuth(result)).toBe(text);
  });

  it("rejects a status without the fields the check depends on", () => {
    expect(authStatusSchema.safeParse({ loggedIn: true, authMethod: "claude.ai" }).success).toBe(
      false,
    );
  });
});
