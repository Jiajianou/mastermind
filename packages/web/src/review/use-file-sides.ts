import type { FileChange, FileContent } from "@mastermind/core/contracts";
import { useState } from "react";
import { errorMessage } from "../components/errors.js";
import { useApi, useLive } from "../store/hooks.js";
import { useCoalescedLoad } from "./use-coalesced-load.js";

export interface FileTarget {
  taskId: string;
  path: string;
  basePath: string | null;
  since: string;
}

export type FileSides =
  | { kind: "loaded"; base: FileContent | null; current: FileContent }
  | { kind: "failed"; message: string };

const targetKey = ({ taskId, path, basePath, since }: FileTarget): string =>
  JSON.stringify([taskId, path, basePath, since]);

// basePath null reads only the file on disk. The open file is read again on every edit that lands on it or that
// could have (a shell command), and when `refresh` changes (the changes list saw the file move some other way).
export function useFileSides(target: FileTarget, refresh: string): FileSides | null {
  const api = useApi();
  const live = useLive((state) => state.connection === "live");
  const revision = useLive((state) => {
    const workspace = state.workspaces[target.taskId];
    return workspace === undefined
      ? 0
      : Math.max(workspace.files[target.path] ?? 0, workspace.anyFile);
  });
  const [loaded, setLoaded] = useState<{ key: string; sides: FileSides } | null>(null);
  const key = targetKey(target);

  useCoalescedLoad(live ? `${key}@${String(revision)}:${refresh}` : null, async () => {
    const { taskId, path, basePath, since } = target;
    try {
      const [base, current] = await Promise.all([
        basePath === null ? null : api.file(taskId, basePath, "base", since),
        api.file(taskId, path, "current"),
      ]);
      setLoaded({ key, sides: { kind: "loaded", base, current } });
    } catch (error) {
      setLoaded({ key, sides: { kind: "failed", message: errorMessage(error) } });
    }
  });

  return loaded?.key === key ? loaded.sides : null;
}

export function changeRefresh(change: FileChange | null): string {
  if (change === null) return "unchanged";
  const { status, additions, deletions, uncommitted } = change;
  return JSON.stringify([status, additions, deletions, uncommitted]);
}

export function diffTarget(
  taskId: string,
  path: string,
  change: FileChange | null,
  since: string,
): FileTarget {
  return { taskId, path, basePath: change?.oldPath ?? path, since };
}
