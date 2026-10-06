import type { Check, Session } from "@mastermind/core/contracts";
import { useMemo } from "react";
import { useLive } from "../store/hooks.js";
import { fixReason } from "./session-list.js";

const noChecks: Readonly<Record<number, Check>> = {};

export function FixerReason({ session }: { session: Session }) {
  const { taskId } = session;
  const checks =
    useLive((state) => (taskId === null ? noChecks : state.checks[taskId])) ?? noChecks;
  const rebase = useLive((state) => (taskId === null ? undefined : state.rebases[taskId]));
  const reason = useMemo(() => fixReason(Object.values(checks), rebase), [checks, rebase]);
  return (
    <p className="fix-reason">
      Attempt {String(session.attempt ?? 1)} · {reason}
    </p>
  );
}
