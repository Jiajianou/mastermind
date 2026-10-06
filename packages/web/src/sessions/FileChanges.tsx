import { plural } from "@mastermind/core/contracts";
import type { FileChange } from "./activity.js";

const shownFiles = 5;

export function FileChanges({ files }: { files: readonly FileChange[] }) {
  if (files.length === 0) return <p className="muted file-summary">No files changed yet</p>;
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const removed = files.reduce((sum, file) => sum + file.removed, 0);
  const hidden = files.length - shownFiles;
  return (
    <div className="file-changes">
      <p className="file-summary">
        {plural(files.length, "file")} <LineCounts added={added} removed={removed} />
      </p>
      <ul>
        {files.slice(0, shownFiles).map((file) => (
          <li key={file.path}>
            <code>{file.path}</code> <LineCounts added={file.added} removed={file.removed} />
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="muted file-summary">and {String(hidden)} more</p>}
    </div>
  );
}

function LineCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="line-counts">
      <span className="added">+{String(added)}</span>{" "}
      <span className="removed">−{String(removed)}</span>
    </span>
  );
}
