import { z } from "zod";
import type { ClaudeCli } from "./claude.js";
import { planLabel, subscriptionPlanSchema } from "./contracts/index.js";
import type { SubscriptionPlan } from "./contracts/index.js";
import type { ExitResult } from "./procs.js";

export const authStatusSchema = z.looseObject({
  loggedIn: z.boolean(),
  authMethod: z.string(),
  apiProvider: z.string(),
  email: z.string().nullish(),
  subscriptionType: z.string().nullish(),
  apiKeySource: z.string().nullish(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

export type WrongKindReason =
  | { reason: "api-billing" }
  | { reason: "api-key-helper" }
  | { reason: "provider"; provider: string }
  | { reason: "plan"; plan: string | null }
  | { reason: "unverified-token" }
  | { reason: "auth-method"; method: string };

export interface AcceptedAuth {
  kind: "accepted";
  email: string | null;
  plan: SubscriptionPlan;
}

export type AuthVerdict =
  AcceptedAuth | { kind: "not-signed-in" } | ({ kind: "wrong-kind" } & WrongKindReason);

export class AuthStatusError extends Error {
  override readonly name = "AuthStatusError";

  constructor(
    readonly exit: ExitResult,
    readonly output: string,
    options: { cause?: unknown } = {},
  ) {
    super(`could not read \`claude auth status --json\`: ${output.trim() || "no output"}`, options);
  }
}

function planOf(status: AuthStatus): SubscriptionPlan | null {
  const parsed = subscriptionPlanSchema.safeParse(status.subscriptionType);
  return parsed.success ? parsed.data : null;
}

export function classifyAuth(status: AuthStatus): AuthVerdict {
  if (!status.loggedIn) return { kind: "not-signed-in" };
  if (status.apiProvider !== "firstParty")
    return { kind: "wrong-kind", reason: "provider", provider: status.apiProvider };
  if (status.apiKeySource === "apiKeyHelper")
    return { kind: "wrong-kind", reason: "api-key-helper" };
  if (status.authMethod === "api_key" || status.authMethod === "console")
    return { kind: "wrong-kind", reason: "api-billing" };

  const plan = planOf(status);
  const email = status.email ?? null;
  switch (status.authMethod) {
    case "claude.ai":
      return plan === null
        ? { kind: "wrong-kind", reason: "plan", plan: status.subscriptionType ?? null }
        : { kind: "accepted", email, plan };
    // A setup-token reports no plan, so it is accepted only if a later Claude Code shows it to be Pro or Max.
    case "oauth_token":
      return plan === null
        ? { kind: "wrong-kind", reason: "unverified-token" }
        : { kind: "accepted", email, plan };
    default:
      return { kind: "wrong-kind", reason: "auth-method", method: status.authMethod };
  }
}

export async function readAuthStatus(cli: ClaudeCli): Promise<AuthStatus> {
  const { exit, stdout, stderr } = await cli.run({ command: "auth-status" });
  const output = [stdout, stderr].join("\n");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stdout);
  } catch (error) {
    throw new AuthStatusError(exit, output, { cause: error });
  }
  const parsed = authStatusSchema.safeParse(parsedJson);
  if (!parsed.success) throw new AuthStatusError(exit, output, { cause: parsed.error });
  return parsed.data;
}

export async function checkAuth(cli: ClaudeCli): Promise<AuthVerdict> {
  return classifyAuth(await readAuthStatus(cli));
}

export function login(cli: ClaudeCli): Promise<ExitResult> {
  return cli.handOff({ command: "auth-login" });
}

export function logout(cli: ClaudeCli): Promise<ExitResult> {
  return cli.handOff({ command: "auth-logout" });
}

const providerNames: Readonly<Record<string, string>> = {
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  foundry: "Microsoft Foundry",
};

const otherPlanNames: Readonly<Record<string, string>> = {
  free: "the free plan",
  team: "a Team plan",
  enterprise: "an Enterprise plan",
};

function describeWrongKind(wrongKind: WrongKindReason): string {
  switch (wrongKind.reason) {
    case "api-billing":
      return "API billing";
    case "api-key-helper":
      return "an apiKeyHelper from your Claude settings, which bills through the API";
    case "provider":
      return providerNames[wrongKind.provider] ?? `the ${wrongKind.provider} provider`;
    case "plan":
      return wrongKind.plan === null
        ? "no Claude subscription"
        : (otherPlanNames[wrongKind.plan] ?? `the ${wrongKind.plan} plan`);
    case "unverified-token":
      return "CLAUDE_CODE_OAUTH_TOKEN, which does not show a Pro or Max plan (unset it to use your normal sign-in)";
    case "auth-method":
      return `the "${wrongKind.method}" sign-in method`;
  }
}

export const signInPrompt =
  "Mastermind needs a Claude Pro or Max account. Press Enter to sign in in your browser · Esc to quit";

export const signInExpiredPrompt = "Your Claude sign-in expired. Press Enter to sign in again.";

export const switchAccountWarning =
  "Signing in with a different account signs Claude Code out everywhere on this machine.";

export function describeAuth(verdict: AuthVerdict): string {
  switch (verdict.kind) {
    case "accepted":
      return verdict.email === null
        ? `✓ Signed in (${planLabel(verdict.plan)})`
        : `✓ Signed in as ${verdict.email} (${planLabel(verdict.plan)})`;
    case "not-signed-in":
      return signInPrompt;
    case "wrong-kind":
      return `This account uses ${describeWrongKind(verdict)}. Mastermind supports Claude Pro and Max subscriptions only.`;
  }
}
