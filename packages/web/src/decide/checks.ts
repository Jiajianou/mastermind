import type { Check, CheckKind, CheckStatus } from "@mastermind/core/contracts";

const pipelineOrder: readonly CheckKind[] = [
  "setup",
  "build",
  "acceptance",
  "rebase",
  "suite",
  "reviewer",
];

export const checkStatusWords: Record<CheckStatus, string> = {
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  killed: "Stopped",
};

const byId = (a: Check, b: Check): number => a.id - b.id;

export function roundChecks(checks: readonly Check[], round: number): Check[] {
  const latest = new Map<CheckKind, Check>();
  for (const check of [...checks].sort(byId))
    if (check.round === round) latest.set(check.kind, check);
  return pipelineOrder.flatMap((kind) => latest.get(kind) ?? []);
}

export interface Failure {
  check: Check;
  passedSince: boolean;
}

export function latestFailure(checks: readonly Check[], round: number): Failure | null {
  const inRound = checks.filter((check) => check.round === round).sort(byId);
  const failed = inRound.findLast((check) => check.status === "failed");
  if (failed === undefined) return null;
  const passedSince = inRound.some(
    (check) => check.kind === failed.kind && check.id > failed.id && check.status === "passed",
  );
  return { check: failed, passedSince };
}
