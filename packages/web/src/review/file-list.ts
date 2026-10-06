import type { ChangeStatus, FileChange } from "@mastermind/core/contracts";

export type FileMarker = "M" | "A" | "D" | "R";

export interface FileEntry {
  path: string;
  name: string;
  marker: FileMarker | null;
  editing: boolean;
  change: FileChange | null;
}

export interface DirectoryGroup {
  directory: string;
  files: FileEntry[];
}

const markers: Record<ChangeStatus, FileMarker> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
};

export const markerWords: Record<FileMarker, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
};

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function splitPath(path: string): { directory: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { directory: "", name: path }
    : { directory: path.slice(0, slash), name: path.slice(slash + 1) };
}

function groupEntries(entries: readonly FileEntry[]): DirectoryGroup[] {
  const groups = new Map<string, FileEntry[]>();
  for (const entry of entries) {
    const { directory } = splitPath(entry.path);
    groups.set(directory, [...(groups.get(directory) ?? []), entry]);
  }
  return [...groups]
    .sort(([a], [b]) => compareText(a, b))
    .map(([directory, files]) => ({
      directory,
      files: files.sort((a, b) => compareText(a.name, b.name)),
    }));
}

function entryFor(path: string, change: FileChange | null, editing: string | null): FileEntry {
  return {
    path,
    name: splitPath(path).name,
    marker: change === null ? null : markers[change.status],
    editing: path === editing,
    change,
  };
}

export function changedFileGroups(
  changes: readonly FileChange[],
  editing: string | null,
): DirectoryGroup[] {
  return groupEntries(changes.map((change) => entryFor(change.path, change, editing)));
}

export function treeFileGroups(
  paths: readonly string[],
  changes: readonly FileChange[],
  editing: string | null,
): DirectoryGroup[] {
  const changed = new Map(changes.map((change) => [change.path, change]));
  return groupEntries(paths.map((path) => entryFor(path, changed.get(path) ?? null, editing)));
}

export function defaultFile(groups: readonly DirectoryGroup[]): string | null {
  const entries = groups.flatMap((group) => group.files);
  return (entries.find((entry) => entry.editing) ?? entries[0])?.path ?? null;
}
