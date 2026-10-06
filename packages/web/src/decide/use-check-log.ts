import type { Check, CheckLog } from "@mastermind/core/contracts";
import { useState } from "react";
import { errorMessage } from "../components/errors.js";
import { useCoalescedLoad } from "../review/use-coalesced-load.js";
import { useApi, useLive } from "../store/hooks.js";

export type LogView = { kind: "loaded"; log: CheckLog } | { kind: "failed"; message: string };

export function useCheckLog(check: Check | null): LogView | null {
  const api = useApi();
  const live = useLive((state) => state.connection === "live");
  const [loaded, setLoaded] = useState<{ key: string; view: LogView } | null>(null);
  const key = check === null ? null : `${String(check.id)}:${check.status}`;

  useCoalescedLoad(live ? key : null, async () => {
    if (check === null || key === null) return;
    try {
      setLoaded({ key, view: { kind: "loaded", log: await api.checkLog(check.id) } });
    } catch (error) {
      setLoaded({ key, view: { kind: "failed", message: errorMessage(error) } });
    }
  });

  return loaded?.key === key ? loaded.view : null;
}
