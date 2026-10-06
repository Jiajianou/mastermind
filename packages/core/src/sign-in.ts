import { setSignInRequired } from "./actions/index.js";
import type { SignInScope } from "./actions/index.js";
import { AuthStatusError, checkAuth, login } from "./auth.js";
import type { AuthVerdict } from "./auth.js";
import type { ClaudeCli } from "./claude.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db/index.js";
import type { EventBus } from "./events.js";

export const signInCheckEveryMs = 15 * 60_000;
export const signInFreshForMs = 5 * 60_000;

export interface SignInMonitorOptions {
  db: Db;
  bus: EventBus;
  cli: ClaudeCli;
  clock: Clock;
  onError: (error: unknown) => void;
  lastCheckedAt?: Date | null;
}

export interface SignInMonitor {
  start(): void;
  stop(): void;
  ensureSignedIn(): Promise<boolean>;
  signIn(): Promise<AuthVerdict | null>;
}

// Watches the Claude sign-in while mastermind runs (PLAN 4.3): a check every 15 minutes, and before a session starts
// when the last one is more than 5 minutes old. A refused check pauses work until a good one.
export function createSignInMonitor(options: SignInMonitorOptions): SignInMonitor {
  const { db, bus, cli, clock, onError } = options;
  const scope: SignInScope = {
    db,
    emit: (event) => {
      bus.emit(event);
    },
  };
  let lastCheckedAt = options.lastCheckedAt ?? null;
  let inFlight: Promise<AuthVerdict | null> | null = null;
  let signingIn: Promise<AuthVerdict | null> | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  function apply(verdict: AuthVerdict): void {
    const accepted = verdict.kind === "accepted";
    if (db.flags.get().authRequired === accepted) setSignInRequired(scope, !accepted);
  }

  // A status that can't be read says nothing about the sign-in, so the flags are left as they are.
  async function runCheck(): Promise<AuthVerdict | null> {
    try {
      const verdict = await checkAuth(cli);
      lastCheckedAt = clock.now();
      apply(verdict);
      return verdict;
    } catch (error) {
      if (!(error instanceof AuthStatusError)) throw error;
      onError(error);
      return null;
    }
  }

  function check(): Promise<AuthVerdict | null> {
    inFlight ??= runCheck().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  const isFresh = (): boolean =>
    lastCheckedAt !== null && clock.now().getTime() - lastCheckedAt.getTime() <= signInFreshForMs;

  async function handOffLogin(): Promise<AuthVerdict | null> {
    await login(cli);
    return check();
  }

  return {
    start() {
      timer ??= setInterval(() => {
        check().catch(onError);
      }, signInCheckEveryMs);
      if (db.flags.get().authRequired) check().catch(onError);
    },

    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },

    async ensureSignedIn() {
      if (db.flags.get().authRequired) return false;
      if (!isFresh()) await check();
      return !db.flags.get().authRequired;
    },

    signIn() {
      signingIn ??= handOffLogin().finally(() => {
        signingIn = null;
      });
      return signingIn;
    },
  };
}
