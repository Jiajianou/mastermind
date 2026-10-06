import type { Check, Rebase, SessionEvent } from "@mastermind/core/contracts";
import { capitalized } from "@mastermind/core/contracts";

function failedCheck(checks: readonly Check[]): Check | undefined {
  const latestByKind = new Map<Check["kind"], Check>();
  for (const check of [...checks].sort((a, b) => a.id - b.id)) latestByKind.set(check.kind, check);
  return [...latestByKind.values()]
    .filter((check) => check.status === "failed")
    .sort((a, b) => b.id - a.id)[0];
}

export function sessionProblem(
  latest: SessionEvent | null,
  checks: readonly Check[],
  rebase: Rebase | undefined,
): string | null {
  if (latest?.type === "error") return `Error: ${latest.summary}`;
  if (rebase?.status === "failed") return "Rebase conflict";
  const failed = failedCheck(checks);
  return failed === undefined ? null : `${capitalized(failed.kind)} check failed`;
}
