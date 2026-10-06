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
    case "auth-required": {
      const flags = db.flags.set({ authRequired: true, paused: true });
      bus.emit({ type: "auth.updated", authRequired: flags.authRequired });
      bus.emit({
        type: "scheduler.updated",
        paused: flags.paused,
        resumeAt: flags.backoffResumeAt,
      });
      return;
    }
    case "none":
      return;
  }
}
