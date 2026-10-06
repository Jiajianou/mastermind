import type { FileChange } from "@mastermind/core/contracts";
import { CodeContents, DiffContents } from "./FileContents.js";
import type { ReviewMode } from "./location.js";
import { changeRefresh, diffTarget, useFileSides } from "./use-file-sides.js";

const shortCommit = (commit: string): string => commit.slice(0, 7);

function stateWord(change: FileChange | null): string {
  if (change === null) return "unchanged";
  return change.uncommitted ? "uncommitted" : "committed";
}

export function FileView({
  taskId,
  path,
  change,
  fromCommit,
  mode,
}: {
  taskId: string;
  path: string;
  change: FileChange | null;
  fromCommit: string;
  mode: ReviewMode;
}) {
  const target =
    mode === "diff" ? diffTarget(taskId, path, change) : { taskId, path, basePath: null };
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
              base <code>{shortCommit(fromCommit)}</code> → on disk
            </span>
          </>
        )}
      </header>
      {mode === "diff" ? (
        <DiffContents path={path} sides={sides} compact={false} />
      ) : (
        <CodeContents path={path} sides={sides} />
      )}
    </section>
  );
}
