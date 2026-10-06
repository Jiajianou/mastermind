import { lazy } from "react";

export const LazyDiffEditor = lazy(() =>
  import("./DiffEditor.js").then(({ DiffEditor }) => ({ default: DiffEditor })),
);

export const LazyCodeEditor = lazy(() =>
  import("./CodeEditor.js").then(({ CodeEditor }) => ({ default: CodeEditor })),
);
