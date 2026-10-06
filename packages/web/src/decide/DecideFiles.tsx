import type { TaskChanges } from "@mastermind/core/contracts";
import { ChangesLoaders } from "../review/ChangesLoaders.js";
import { changedFileGroups, defaultFile } from "../review/file-list.js";
import { FileList } from "../review/FileList.js";
import { FileView } from "../review/FileView.js";
import { useChangesView } from "../review/use-task-changes.js";
import { decidePath } from "./task-state.js";

function DiffMessage({ text }: { text: string }) {
  return <p className="decide-diff panel editor-message muted">{text}</p>;
}

function ChangedFiles({ changes, file }: { changes: TaskChanges; file: string | null }) {
  const groups = changedFileGroups(changes.files, null);
  const open = file ?? defaultFile(groups);
  return (
    <>
      <FileList
        groups={groups}
        selected={open}
        linkTo={(path) => decidePath(changes.taskId, path)}
        empty="No files changed."
      />
      {open === null ? (
        <DiffMessage text="No files changed." />
      ) : (
        <FileView
          taskId={changes.taskId}
          path={open}
          change={changes.files.find((change) => change.path === open) ?? null}
          fromCommit={changes.fromCommit}
          mode="diff"
        />
      )}
    </>
  );
}

export function DecideFiles({ taskId, file }: { taskId: string; file: string | null }) {
  const view = useChangesView(taskId);
  return (
    <>
      <ChangesLoaders taskIds={[taskId]} />
      {view === undefined ? (
        <DiffMessage text="Loading changes…" />
      ) : view.kind === "failed" ? (
        <DiffMessage text={view.message} />
      ) : (
        <ChangedFiles changes={view.changes} file={file} />
      )}
    </>
  );
}
