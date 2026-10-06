import type { TaskChanges } from "@mastermind/core/contracts";
import { useSessionEvents } from "../sessions/use-session-events.js";
import { ChangesLoaders } from "./ChangesLoaders.js";
import { changedFileGroups, defaultFile, treeFileGroups } from "./file-list.js";
import type { DirectoryGroup } from "./file-list.js";
import { FileList } from "./FileList.js";
import { FileView } from "./FileView.js";
import { changesSince, reviewPath } from "./location.js";
import type { ReviewLocation } from "./location.js";
import type { TaskSession } from "./selection.js";
import { SinceToggle } from "./SinceToggle.js";
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
    reviewPath({ session: session.id, mode: location.mode, file: path, since: location.since });
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
          since={changes.since}
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
  const round = session.round ?? 1;
  const since = location.mode === "diff" ? changesSince(location.since, round) : "base";
  const changes = useChangesView(session.taskId, since);
  const { events } = useSessionEvents(session.id);
  const latestEdit = useLatestEdit(session.id, events);
  return (
    <>
      {since !== "base" && <ChangesLoaders taskIds={[session.taskId]} since={since} />}
      {location.mode === "diff" && (
        <SinceToggle
          round={round}
          since={since}
          pathFor={(value) => reviewPath({ session: session.id, since: value })}
        />
      )}
      {changes === undefined ? (
        <p className="review-message muted">Loading changes…</p>
      ) : changes.kind === "failed" ? (
        <p className="review-message">{changes.message}</p>
      ) : location.mode === "diff" ? (
        <ChangedFiles
          session={session}
          changes={changes.changes}
          editing={session.status === "running" ? latestEdit : null}
          location={location}
        />
      ) : (
        <AllFiles
          session={session}
          changes={changes.changes}
          editing={session.status === "running" ? latestEdit : null}
          location={location}
        />
      )}
    </>
  );
}
