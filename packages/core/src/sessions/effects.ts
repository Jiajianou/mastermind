import { setSignInRequired } from "../actions/index.js";
import type { Db } from "../db/index.js";
import type { EventBus } from "../events.js";
import type { SettlementEffect } from "./settlement.js";

export interface UsageBackoff {
  reportUsageLimit(resetAt?: Date): Date;
  reportSuccess(): void;
}

export interface EffectTargets {
  db: Db;
  bus: EventBus;
  backoff: UsageBackoff;
}

export function applySettlementEffect(effect: SettlementEffect, targets: EffectTargets): void {
  const { db, bus, backoff } = targets;
  switch (effect.kind) {
    case "succeeded":
      backoff.reportSuccess();
      return;
    case "usage-limit":
      backoff.reportUsageLimit(effect.resetAt ?? undefined);
      return;
    case "backoff":
      backoff.reportUsageLimit();
      return;
    case "auth-required":
      setSignInRequired(
        {
          db,
          emit: (event) => {
            bus.emit(event);
          },
        },
        true,
      );
      return;
    case "none":
      return;
  }
}

// Claude calls (judges, reviewers, fixers) wait while work is paused, signed out or backing off after a usage limit.
export function claudeCallsAllowed(db: Db, now: Date): boolean {
  const { paused, authRequired, backoffResumeAt } = db.flags.get();
  const backingOff = backoffResumeAt !== null && Date.parse(backoffResumeAt) > now.getTime();
  return !paused && !authRequired && !backingOff;
}
