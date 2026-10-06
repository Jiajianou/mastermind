import { join } from "node:path";
import type { AccountKind } from "./config.js";
import type { FakeState } from "./state.js";

export const ownerEmail = "owner@example.com";
const ownerOrgId = "00000000-0000-4000-8000-000000000001";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const isSet = (value: string | undefined): boolean => value !== undefined && value !== "";

export function effectiveAccount(stored: AccountKind, env: NodeJS.ProcessEnv): AccountKind {
  if (stored === "signed-out") return stored;
  if (env.CLAUDE_CODE_USE_BEDROCK === "1") return "bedrock";
  if (env.CLAUDE_CODE_USE_VERTEX === "1") return "vertex";
  if (isSet(env.ANTHROPIC_API_KEY) || isSet(env.ANTHROPIC_AUTH_TOKEN)) return "api-key";
  if (isSet(env.CLAUDE_CODE_OAUTH_TOKEN)) return "oauth-token";
  return stored;
}

function accountFields(account: AccountKind): Record<string, unknown> {
  const owner = { email: ownerEmail, orgId: ownerOrgId, orgName: `${ownerEmail}'s Organization` };
  switch (account) {
    case "max":
    case "pro":
    case "team":
    case "enterprise":
    case "free":
      return {
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        ...owner,
        subscriptionType: account,
      };
    case "signed-out":
      return { loggedIn: false, authMethod: "none", apiProvider: "firstParty" };
    case "oauth-token":
      return { loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" };
    case "console":
      return { loggedIn: true, authMethod: "console", apiProvider: "firstParty", ...owner };
    case "api-key":
      return {
        loggedIn: true,
        authMethod: "api_key",
        apiProvider: "firstParty",
        apiKeySource: "ANTHROPIC_API_KEY",
      };
    case "api-key-helper":
      return {
        loggedIn: true,
        authMethod: "api_key",
        apiProvider: "firstParty",
        apiKeySource: "apiKeyHelper",
      };
    case "bedrock":
    case "vertex":
      return { loggedIn: true, authMethod: "third_party", apiProvider: account };
  }
}

export function configDirectory(env: NodeJS.ProcessEnv): string {
  const configured = env.CLAUDE_CONFIG_DIR;
  return configured !== undefined && configured !== ""
    ? configured
    : join(env.HOME ?? "/", ".claude");
}

export function authStatus(state: FakeState, env: NodeJS.ProcessEnv, json: boolean): CommandResult {
  const account = effectiveAccount(state.account(), env);
  const configDir = configDirectory(env);
  const status = {
    ...accountFields(account),
    analyticsDisabled: false,
    projectsDirectory: join(configDir, "projects"),
    configDirectory: configDir,
  };
  const exitCode = account === "signed-out" ? 1 : 0;
  if (json) return { stdout: `${JSON.stringify(status, null, 2)}\n`, stderr: "", exitCode };
  const text =
    account === "signed-out"
      ? "Not logged in. Run claude auth login to authenticate."
      : "Logged in.";
  return { stdout: `${text}\n`, stderr: "", exitCode };
}

export function authLogin(state: FakeState, account: AccountKind, fails: boolean): CommandResult {
  if (fails)
    return { stdout: "", stderr: "Login failed: the sign-in was cancelled.\n", exitCode: 1 };
  state.setAccount(account);
  return { stdout: "Login successful.\n", stderr: "", exitCode: 0 };
}

export function authLogout(state: FakeState): CommandResult {
  state.setAccount("signed-out");
  return {
    stdout: "Successfully logged out from your Anthropic account.\n",
    stderr: "",
    exitCode: 0,
  };
}
