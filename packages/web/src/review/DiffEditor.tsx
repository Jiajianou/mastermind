import { useEffect, useRef } from "react";
import { languageFor, monaco, readOnlyOptions, showText } from "./monaco.js";

export interface DiffEditorProps {
  path: string;
  original: string;
  modified: string;
  compact: boolean;
}

interface DiffModels {
  original: monaco.editor.ITextModel;
  modified: monaco.editor.ITextModel;
}

function diffOptions(compact: boolean): monaco.editor.IStandaloneDiffEditorConstructionOptions {
  return {
    ...readOnlyOptions,
    originalEditable: false,
    renderSideBySide: !compact,
    useInlineViewWhenSpaceIsLimited: true,
    renderIndicators: true,
    renderMarginRevertIcon: false,
    renderOverviewRuler: !compact,
    hideUnchangedRegions: { enabled: compact },
    ...(compact ? { lineNumbers: "off", folding: false } : {}),
  };
}

export function DiffEditor({ path, original, modified, compact }: DiffEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const models = useRef<DiffModels | null>(null);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const editor = monaco.editor.createDiffEditor(element, diffOptions(compact));
    const language = languageFor(path);
    const pair = {
      original: monaco.editor.createModel("", language),
      modified: monaco.editor.createModel("", language),
    };
    editor.setModel(pair);
    models.current = pair;
    return () => {
      models.current = null;
      editor.dispose();
      pair.original.dispose();
      pair.modified.dispose();
    };
  }, [path, compact]);

  useEffect(() => {
    const pair = models.current;
    if (pair === null) return;
    showText(pair.original, original);
    showText(pair.modified, modified);
  }, [path, compact, original, modified]);

  return <div className="monaco-host" ref={host} />;
}
