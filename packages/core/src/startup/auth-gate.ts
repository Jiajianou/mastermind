import {
  checkAuth,
  describeAuth,
  login,
  logout,
  signInPrompt,
  switchAccountWarning,
} from "../auth.js";
import type { AcceptedAuth, AuthVerdict, WrongKindReason } from "../auth.js";
import type { ClaudeCli } from "../claude.js";
import type { ExitResult } from "../procs.js";
import { StartupError } from "./errors.js";
import type { StartupPrompts } from "./prompts.js";

export const maxSignInAttempts = 3;

type WrongKind = Extract<AuthVerdict, { kind: "wrong-kind" }>;

// These come from the environment or the owner's Claude settings, which a new sign-in leaves in place, so
// signing out everywhere would cost the owner their sign-in without fixing anything.
function newSignInCanHelp({ reason }: WrongKindReason): boolean {
  return reason !== "provider" && reason !== "api-key-helper" && reason !== "unverified-token";
}

function describeExit(exit: ExitResult): string {
  return exit.kind === "exited"
    ? `exited with code ${String(exit.code)}`
    : `was killed by ${exit.signal}`;
}

async function handOff(
  step: (cli: ClaudeCli) => Promise<ExitResult>,
  command: string,
  cli: ClaudeCli,
  prompts: StartupPrompts,
): Promise<boolean> {
  const exit = await step(cli);
  if (exit.kind === "exited" && exit.code === 0) return true;
  prompts.say(`\`${command}\` ${describeExit(exit)}.`);
  return false;
}

async function offerSignIn(cli: ClaudeCli, prompts: StartupPrompts): Promise<void> {
  if (!(await prompts.pressEnter(signInPrompt)))
    throw new StartupError("quit", "Quit without signing in.");
  await handOff(login, "claude auth login --claudeai", cli, prompts);
}

async function offerAccountSwitch(
  verdict: WrongKind,
  cli: ClaudeCli,
  prompts: StartupPrompts,
): Promise<void> {
  prompts.say(describeAuth(verdict));
  if (!newSignInCanHelp(verdict))
    throw new StartupError(
      "account-refused",
      "Change the sign-in described above, then run mastermind again.",
    );
  prompts.say(switchAccountWarning);
  const choice = await prompts.choose(
    "Sign in with a different account?",
    [
      { value: "switch", label: "Sign out and sign in with a different account" },
      { value: "quit", label: "Quit" },
    ],
    "quit",
  );
  if (choice === "quit")
    throw new StartupError("account-refused", "Quit: this account can't run mastermind.");
  if (await handOff(logout, "claude auth logout", cli, prompts))
    await handOff(login, "claude auth login --claudeai", cli, prompts);
}

export async function passAuthGate(cli: ClaudeCli, prompts: StartupPrompts): Promise<AcceptedAuth> {
  for (let attempts = 0; ; attempts += 1) {
    const verdict = await checkAuth(cli);
    if (verdict.kind === "accepted") {
      prompts.say(describeAuth(verdict));
      return verdict;
    }
    if (attempts === maxSignInAttempts)
      throw new StartupError(
        "sign-in-failed",
        `Sign-in did not succeed after ${String(maxSignInAttempts)} tries. Run mastermind again when you're ready.`,
      );
    if (verdict.kind === "not-signed-in") await offerSignIn(cli, prompts);
    else await offerAccountSwitch(verdict, cli, prompts);
  }
}
