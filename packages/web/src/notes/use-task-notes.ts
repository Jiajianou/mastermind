import type { ReviewNotes } from "@mastermind/core/contracts";
import { useState } from "react";
import { errorMessage } from "../components/errors.js";
import { useCoalescedLoad } from "../review/use-coalesced-load.js";
import { useApi, useDispatch, useLive } from "../store/hooks.js";

export interface TaskNotes {
  notes: ReviewNotes | undefined;
  failure: string | null;
}

// Read again on every task change (the reviewer's findings arrive as checks finish, a new round starts) and after
// every reconnect; comment and finding events keep the notes current in between.
export function useTaskNotes(taskId: string): TaskNotes {
  const api = useApi();
  const dispatch = useDispatch();
  const updatedAt = useLive((state) => state.tasks[taskId]?.updatedAt ?? "");
  const live = useLive((state) => state.connection === "live");
  const notes = useLive((state) => state.notes[taskId]);
  const [failure, setFailure] = useState<string | null>(null);

  useCoalescedLoad(live ? `${taskId}@${updatedAt}` : null, async () => {
    try {
      dispatch({ type: "notes.loaded", notes: await api.notes(taskId) });
      setFailure(null);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  });

  return { notes, failure };
}
