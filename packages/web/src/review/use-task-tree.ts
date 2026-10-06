import { useState } from "react";
import { errorMessage } from "../components/errors.js";
import { useApi, useLive } from "../store/hooks.js";
import { useCoalescedLoad } from "./use-coalesced-load.js";

export type TreeView = { kind: "loaded"; files: string[] } | { kind: "failed"; message: string };

export function useTaskTree(taskId: string): TreeView | null {
  const api = useApi();
  const live = useLive((state) => state.connection === "live");
  const revision = useLive((state) => state.workspaces[taskId]?.revision ?? 0);
  const [loaded, setLoaded] = useState<{ taskId: string; tree: TreeView } | null>(null);

  useCoalescedLoad(live ? `${taskId}@${String(revision)}` : null, async () => {
    try {
      const { files } = await api.tree(taskId);
      setLoaded({ taskId, tree: { kind: "loaded", files } });
    } catch (error) {
      setLoaded({ taskId, tree: { kind: "failed", message: errorMessage(error) } });
    }
  });

  return loaded?.taskId === taskId ? loaded.tree : null;
}
