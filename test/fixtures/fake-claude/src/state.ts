import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { accountKindSchema } from "./config.js";
import { FakeSetupError } from "./errors.js";
import type { AccountKind } from "./config.js";

const authFileSchema = z.object({ account: accountKindSchema });

export interface FakeState {
  account(): AccountKind;
  setAccount(account: AccountKind): void;
  hasSession(sessionId: string): boolean;
  addSession(sessionId: string): void;
}

export function openState(dir: string | undefined, initialAccount: AccountKind): FakeState {
  const requireDir = (): string => {
    if (dir === undefined)
      throw new FakeSetupError("FAKE_CLAUDE_STATE must name a directory to change auth state");
    return dir;
  };
  const authFile = dir === undefined ? undefined : join(dir, "auth.json");
  const sessionFile = (sessionId: string): string => join(requireDir(), "sessions", sessionId);

  return {
    account() {
      if (authFile === undefined || !existsSync(authFile)) return initialAccount;
      return authFileSchema.parse(JSON.parse(readFileSync(authFile, "utf8"))).account;
    },
    setAccount(account) {
      mkdirSync(requireDir(), { recursive: true });
      writeFileSync(join(requireDir(), "auth.json"), JSON.stringify({ account }));
    },
    hasSession(sessionId) {
      return dir !== undefined && existsSync(sessionFile(sessionId));
    },
    addSession(sessionId) {
      if (dir === undefined) return;
      mkdirSync(join(dir, "sessions"), { recursive: true });
      writeFileSync(sessionFile(sessionId), "");
    },
  };
}
