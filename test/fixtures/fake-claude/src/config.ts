import { z } from "zod";
import { FakeSetupError } from "./errors.js";

export const accountKindSchema = z.enum([
  "max",
  "pro",
  "team",
  "enterprise",
  "free",
  "signed-out",
  "oauth-token",
  "console",
  "api-key",
  "api-key-helper",
  "bedrock",
  "vertex",
]);
export type AccountKind = z.infer<typeof accountKindSchema>;

const flagSchema = z.enum(["0", "1"]).transform((value) => value === "1");

const fakeEnvSchema = z.object({
  FAKE_CLAUDE_VERSION: z.string().min(1).default("2.1.283"),
  FAKE_CLAUDE_ACCOUNT: accountKindSchema.default("max"),
  FAKE_CLAUDE_LOGIN_ACCOUNT: accountKindSchema.default("max"),
  FAKE_CLAUDE_LOGIN_FAIL: flagSchema.default(false),
  FAKE_CLAUDE_STATE: z.string().min(1).optional(),
  FAKE_CLAUDE_SCENARIO: z.string().min(1).optional(),
  FAKE_CLAUDE_LOG: z.string().min(1).optional(),
});

export interface FakeConfig {
  version: string;
  initialAccount: AccountKind;
  loginAccount: AccountKind;
  loginFails: boolean;
  stateDir: string | undefined;
  scenarioPath: string | undefined;
  logPath: string | undefined;
}

export function readConfig(env: NodeJS.ProcessEnv): FakeConfig {
  const parsed = fakeEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new FakeSetupError(`invalid FAKE_CLAUDE_* environment: ${z.prettifyError(parsed.error)}`);
  }
  const values = parsed.data;
  return {
    version: values.FAKE_CLAUDE_VERSION,
    initialAccount: values.FAKE_CLAUDE_ACCOUNT,
    loginAccount: values.FAKE_CLAUDE_LOGIN_ACCOUNT,
    loginFails: values.FAKE_CLAUDE_LOGIN_FAIL,
    stateDir: values.FAKE_CLAUDE_STATE,
    scenarioPath: values.FAKE_CLAUDE_SCENARIO,
    logPath: values.FAKE_CLAUDE_LOG,
  };
}
