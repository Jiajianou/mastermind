import type { FileChange } from "@mastermind/core/contracts";
import type { ReactNode } from "react";
import type { LineSelection } from "./DiffEditor.js";
import { CodeContents, DiffContents } from "./FileContents.js";
import type { ReviewMode } from "./location.js";
import { changeRefresh, diffTarget, useFileSides } from "./use-file-sides.js";
import type { EditorZone } from "./view-zones.js";

export interface DiffNotes {
  zones: readonly EditorZone[];
  onSelectLines: (selection: LineSelection) => void;
  actions: ReactNode;
}

const shortCommit = (commit: string): string => commit.slice(0, 7);

function stateWord(change: FileChange | null): string {
  if (change === null) return "unchanged";
  return change.uncommitted ? "uncommitted" : "committed";
}

export const sinceLabel = (since: string): string =>
  since === "base" ? "base" : since.replace("round:", "end of round ");

export function FileView({
  taskId,
  path,
  change,
  fromCommit,
  since = "base",
  mode,
  notes,
}: {
  taskId: string;
  path: string;
  change: FileChange | null;
  fromCommit: string;
  since?: string;
  mode: ReviewMode;
  notes?: DiffNotes;
}) {
  const target =
    mode === "diff"
      ? diffTarget(taskId, path, change, since)
      : { taskId, path, basePath: null, since };
  const sides = useFileSides(target, `${fromCommit}:${changeRefresh(change)}`);
  return (
    <section
      className="file-view panel"
      aria-label={`${mode === "diff" ? "Diff" : "File"} ${path}`}
    >
      <header className="file-view-header">
        <h2>
          <code>{path}</code>
        </h2>
        {mode === "diff" && (
          <>
            <span className="state-tag">{stateWord(change)}</span>
            <span className="muted diff-sides">
              {sinceLabel(since)} <code>{shortCommit(fromCommit)}</code> → on disk
            </span>
          </>
        )}
        {notes?.actions}
      </header>
      {mode === "diff" ? (
        <DiffContents
          path={path}
          sides={sides}
          compact={false}
          zones={notes?.zones}
          onSelectLines={notes?.onSelectLines}
        />
      ) : (
        <CodeContents path={path} sides={sides} />
      )}
    </section>
  );
}
