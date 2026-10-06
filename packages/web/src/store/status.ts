import type { IsoTimestamp } from "@mastermind/core/contracts";
import type { Connection, SchedulerState } from "./state.js";

export type Tone = "ok" | "attention" | "quiet";

export interface RunStatus {
  word: string;
  tone: Tone;
}

export type Banner =
  | { kind: "stopped" }
  | { kind: "unauthorized" }
  | { kind: "sign-in" }
  | { kind: "usage-limit"; resumeAt: IsoTimestamp };

const connectionStatus: Record<Exclude<Connection, "live">, RunStatus> = {
  connecting: { word: "Connecting", tone: "quiet" },
  reconnecting: { word: "Reconnecting", tone: "attention" },
  stopped: { word: "Stopped", tone: "attention" },
  unauthorized: { word: "No access", tone: "attention" },
};

export function runStatus(connection: Connection, scheduler: SchedulerState): RunStatus {
  if (connection !== "live") return connectionStatus[connection];
  if (scheduler.authRequired) return { word: "Sign-in needed", tone: "attention" };
  if (scheduler.resumeAt !== null) return { word: "Usage limit", tone: "attention" };
  if (scheduler.paused) return { word: "Paused", tone: "quiet" };
  return { word: "Running", tone: "ok" };
}

export function banners(connection: Connection, scheduler: SchedulerState): Banner[] {
  if (connection === "stopped" || connection === "unauthorized") return [{ kind: connection }];
  if (connection !== "live") return [];
  const shown: Banner[] = [];
  if (scheduler.authRequired) shown.push({ kind: "sign-in" });
  if (scheduler.resumeAt !== null)
    shown.push({ kind: "usage-limit", resumeAt: scheduler.resumeAt });
  return shown;
}
