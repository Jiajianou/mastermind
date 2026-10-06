import type { Check } from "@mastermind/core/contracts";
import { useMemo, useState } from "react";
import { errorMessage } from "../components/errors.js";
import { useCoalescedLoad } from "../review/use-coalesced-load.js";
import { useApi, useDispatch, useLive } from "../store/hooks.js";

export interface TaskChecks {
  checks: readonly Check[];
  failure: string | null;
}

// Every task change (a new round, a move to checking or back to review) and every reconnect reads the checks again;
// check.updated keeps them current in between.
export function useTaskChecks(taskId: string): TaskChecks {
  const api = useApi();
  const dispatch = useDispatch();
  const updatedAt = useLive((state) => state.tasks[taskId]?.updatedAt ?? "");
  const live = useLive((state) => state.connection === "live");
  const stored = useLive((state) => state.checks[taskId]);
  const [failure, setFailure] = useState<string | null>(null);

  useCoalescedLoad(live ? `${taskId}@${updatedAt}` : null, async () => {
    try {
      dispatch({ type: "checks.loaded", taskId, checks: await api.checks(taskId) });
      setFailure(null);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  });

  const checks = useMemo(() => Object.values(stored ?? {}), [stored]);
  return { checks, failure };
}
