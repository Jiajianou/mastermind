import { Suspense } from "react";
import { LazyCodeEditor, LazyDiffEditor } from "./editors.js";
import { sideText } from "./file-text.js";
import type { FileSides } from "./use-file-sides.js";

function Message({ text }: { text: string }) {
  return <p className="editor-message muted">{text}</p>;
}

const loadingEditor = <Message text="Loading editor…" />;

export function DiffContents({
  path,
  sides,
  compact,
}: {
  path: string;
  sides: FileSides | null;
  compact: boolean;
}) {
  if (sides === null) return <Message text="Loading…" />;
  if (sides.kind === "failed") return <Message text={sides.message} />;
  const original = sideText(sides.base);
  const modified = sideText(sides.current);
  if (original.kind === "unavailable") return <Message text={original.reason} />;
  if (modified.kind === "unavailable") return <Message text={modified.reason} />;
  return (
    <Suspense fallback={loadingEditor}>
      <LazyDiffEditor
        path={path}
        original={original.text}
        modified={modified.text}
        compact={compact}
      />
    </Suspense>
  );
}

export function CodeContents({ path, sides }: { path: string; sides: FileSides | null }) {
  if (sides === null) return <Message text="Loading…" />;
  if (sides.kind === "failed") return <Message text={sides.message} />;
  if (sides.current.kind === "missing") return <Message text="This file is not on disk." />;
  const current = sideText(sides.current);
  if (current.kind === "unavailable") return <Message text={current.reason} />;
  return (
    <Suspense fallback={loadingEditor}>
      <LazyCodeEditor path={path} text={current.text} />
    </Suspense>
  );
}
