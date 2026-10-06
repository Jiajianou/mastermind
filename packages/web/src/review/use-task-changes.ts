import type { ChangesView } from "../store/state.js";
import { useApi, useDispatch, useLive } from "../store/hooks.js";
import { errorMessage } from "../components/errors.js";
import { useCoalescedLoad } from "./use-coalesced-load.js";

export function useChangesView(taskId: string): ChangesView | undefined {
  return useLive((state) => state.changes[taskId]);
}

// Reads the task's changes again whenever its workspace moves (an edit lands, a commit, a session ends) and after
// every reconnect, since events may have been missed.
export function useLoadTaskChanges(taskId: string): void {
  const api = useApi();
  const dispatch = useDispatch();
  const revision = useLive((state) => state.workspaces[taskId]?.revision ?? 0);
  const live = useLive((state) => state.connection === "live");

  useCoalescedLoad(live ? `${taskId}@${String(revision)}` : null, async () => {
    try {
      const changes = await api.changes(taskId);
      dispatch({ type: "changes.loaded", taskId, view: { kind: "loaded", changes } });
    } catch (error) {
      dispatch({
        type: "changes.loaded",
        taskId,
        view: { kind: "failed", message: errorMessage(error) },
      });
    }
  });
}
