import type { TaskChanges } from "@mastermind/core/contracts";
import { useSessionEvents } from "../sessions/use-session-events.js";
import { changedFileGroups, defaultFile, treeFileGroups } from "./file-list.js";
import type { DirectoryGroup } from "./file-list.js";
import { FileList } from "./FileList.js";
import { FileView } from "./FileView.js";
import { reviewPath } from "./location.js";
import type { ReviewLocation } from "./location.js";
import type { TaskSession } from "./selection.js";
import { useLatestEdit } from "./use-editing.js";
import { useChangesView } from "./use-task-changes.js";
import { useTaskTree } from "./use-task-tree.js";

interface FilesProps {
  session: TaskSession;
  changes: TaskChanges;
  editing: string | null;
  location: ReviewLocation;
}

function ReviewBody({
  session,
  changes,
  location,
  groups,
  empty,
}: FilesProps & { groups: readonly DirectoryGroup[]; empty: string }) {
  const file = location.file ?? defaultFile(groups);
  const linkTo = (path: string) =>
    reviewPath({ session: session.id, mode: location.mode, file: path });
  return (
    <div className="review-body">
      <FileList groups={groups} selected={file} linkTo={linkTo} empty={empty} />
      {file === null ? (
        <p className="file-view panel editor-message muted">{empty}</p>
      ) : (
        <FileView
          taskId={session.taskId}
          path={file}
          change={changes.files.find((change) => change.path === file) ?? null}
          fromCommit={changes.fromCommit}
          mode={location.mode}
        />
      )}
    </div>
  );
}

function ChangedFiles(props: FilesProps) {
  const groups = changedFileGroups(props.changes.files, props.editing);
  return <ReviewBody {...props} groups={groups} empty="No files changed yet." />;
}

function AllFiles(props: FilesProps) {
  const tree = useTaskTree(props.session.taskId);
  if (tree === null) return <p className="review-message muted">Loading files…</p>;
  if (tree.kind === "failed") return <p className="review-message">{tree.message}</p>;
  const groups = treeFileGroups(tree.files, props.changes.files, props.editing);
  return <ReviewBody {...props} groups={groups} empty="This task has no files." />;
}

export function SessionReview({
  session,
  location,
}: {
  session: TaskSession;
  location: ReviewLocation;
}) {
  const changes = useChangesView(session.taskId);
  const { events } = useSessionEvents(session.id);
  const latestEdit = useLatestEdit(session.id, events);
  if (changes === undefined) return <p className="review-message muted">Loading changes…</p>;
  if (changes.kind === "failed") return <p className="review-message">{changes.message}</p>;
  const props = {
    session,
    changes: changes.changes,
    editing: session.status === "running" ? latestEdit : null,
    location,
  };
  return location.mode === "diff" ? <ChangedFiles {...props} /> : <AllFiles {...props} />;
}
