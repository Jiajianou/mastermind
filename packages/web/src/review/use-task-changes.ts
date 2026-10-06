import { errorMessage } from "@mastermind/core/contracts";
import { changesKey } from "../store/state.js";
import type { ChangesView } from "../store/state.js";
import { useApi, useDispatch, useLive } from "../store/hooks.js";
import { useCoalescedLoad } from "./use-coalesced-load.js";

export function useChangesView(taskId: string, since = "base"): ChangesView | undefined {
  return useLive((state) => state.changes[changesKey(taskId, since)]);
}

// Reads the task's changes again whenever its workspace moves (an edit lands, a commit, a session ends), when a
// rebase gives it a new base commit, when a new round starts, and after every reconnect, since events may have
// been missed.
export function useLoadTaskChanges(taskId: string, since: string): void {
  const api = useApi();
  const dispatch = useDispatch();
  const revision = useLive((state) => state.workspaces[taskId]?.revision ?? 0);
  const baseCommit = useLive((state) => state.tasks[taskId]?.baseCommit ?? "");
  const round = useLive((state) => state.tasks[taskId]?.round ?? 0);
  const live = useLive((state) => state.connection === "live");
  const key = changesKey(taskId, since);

  useCoalescedLoad(
    live ? `${key}@${String(revision)}@${baseCommit}@${String(round)}` : null,
    async () => {
      try {
        const changes = await api.changes(taskId, since);
        dispatch({ type: "changes.loaded", key, view: { kind: "loaded", changes } });
      } catch (error) {
        dispatch({
          type: "changes.loaded",
          key,
          view: { kind: "failed", message: errorMessage(error) },
        });
      }
    },
  );
}
