import type { Task, TaskChanges } from "@mastermind/core/contracts";
import { fileNotes, noteCounts } from "../notes/notes.js";
import type { RoundNotes } from "../notes/notes.js";
import { ChangesLoaders } from "../review/ChangesLoaders.js";
import { changedFileGroups, defaultFile } from "../review/file-list.js";
import { FileList } from "../review/FileList.js";
import { SinceToggle } from "../review/SinceToggle.js";
import { useChangesView } from "../review/use-task-changes.js";
import { NotedFileView } from "./NotedFileView.js";
import { decidePath } from "./task-state.js";

function DiffMessage({ text }: { text: string }) {
  return <p className="decide-diff panel editor-message muted">{text}</p>;
}

interface FilesProps {
  task: Task;
  file: string | null;
  since: string;
  notes: RoundNotes;
}

function ChangedFiles({
  task,
  file,
  since,
  notes,
  changes,
}: FilesProps & { changes: TaskChanges }) {
  const groups = changedFileGroups(changes.files, null);
  const open = file ?? defaultFile(groups);
  return (
    <>
      <div className="decide-files">
        <SinceToggle
          round={task.round}
          since={since}
          pathFor={(value) => decidePath(task.id, null, value)}
        />
        <FileList
          groups={groups}
          selected={open}
          linkTo={(path) => decidePath(task.id, path, since)}
          empty={since === "base" ? "No files changed." : "Nothing changed since that round."}
          noteCounts={noteCounts(notes)}
        />
      </div>
      {open === null ? (
        <DiffMessage text="No files changed." />
      ) : (
        <NotedFileView
          key={open}
          task={task}
          path={open}
          change={changes.files.find((change) => change.path === open) ?? null}
          fromCommit={changes.fromCommit}
          since={since}
          notes={fileNotes(notes, open)}
        />
      )}
    </>
  );
}

export function DecideFiles(props: FilesProps) {
  const { task, since } = props;
  const view = useChangesView(task.id, since);
  return (
    <>
      <ChangesLoaders taskIds={[task.id]} since={since} />
      {view === undefined ? (
        <DiffMessage text="Loading changes…" />
      ) : view.kind === "failed" ? (
        <DiffMessage text={view.message} />
      ) : (
        <ChangedFiles {...props} changes={view.changes} />
      )}
    </>
  );
}
