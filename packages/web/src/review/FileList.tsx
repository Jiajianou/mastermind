import type { FileChange } from "@mastermind/core/contracts";
import { Link } from "react-router";
import { markerWords } from "./file-list.js";
import type { DirectoryGroup, FileEntry } from "./file-list.js";

function LineCounts({ change }: { change: FileChange }) {
  if (change.additions === null || change.deletions === null)
    return <span className="line-counts muted">binary</span>;
  return (
    <span className="line-counts">
      <span className="added">+{String(change.additions)}</span>{" "}
      <span className="removed">−{String(change.deletions)}</span>
    </span>
  );
}

function FileLink({
  entry,
  to,
  selected,
  notes,
}: {
  entry: FileEntry;
  to: string;
  selected: boolean;
  notes: number;
}) {
  return (
    <Link className="file-link" to={to} aria-current={selected ? "true" : undefined}>
      {entry.marker === null ? (
        <span className="file-marker" />
      ) : (
        <abbr className={`file-marker marker-${entry.marker}`} title={markerWords[entry.marker]}>
          {entry.marker}
        </abbr>
      )}
      <code className="file-name">{entry.name}</code>
      {entry.editing && <span className="editing-tag">editing</span>}
      {notes > 0 && (
        <span className="note-count">
          {notes} note{notes === 1 ? "" : "s"}
        </span>
      )}
      {entry.change !== null && <LineCounts change={entry.change} />}
    </Link>
  );
}

export function FileList({
  groups,
  selected,
  linkTo,
  empty,
  noteCounts = {},
}: {
  groups: readonly DirectoryGroup[];
  selected: string | null;
  linkTo: (path: string) => string;
  empty: string;
  noteCounts?: Readonly<Record<string, number>>;
}) {
  return (
    <nav className="file-list panel" aria-label="Files">
      {groups.length === 0 && <p className="muted">{empty}</p>}
      {groups.map((group) => (
        <div key={group.directory} className="file-group">
          <h3>
            <code>{group.directory === "" ? "./" : `${group.directory}/`}</code>
          </h3>
          <ul>
            {group.files.map((entry) => (
              <li key={entry.path}>
                <FileLink
                  entry={entry}
                  to={linkTo(entry.path)}
                  selected={entry.path === selected}
                  notes={noteCounts[entry.path] ?? 0}
                />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
