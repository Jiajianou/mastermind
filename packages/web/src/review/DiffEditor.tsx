import { useEffect, useLayoutEffect, useRef } from "react";
import { languageFor, monaco, readOnlyOptions, showText } from "./monaco.js";
import { useViewZones } from "./view-zones.js";
import type { EditorZone } from "./view-zones.js";

export interface LineSelection {
  start: number;
  end: number;
  text: string;
}

export interface DiffEditorProps {
  path: string;
  original: string;
  modified: string;
  compact: boolean;
  zones?: readonly EditorZone[];
  onSelectLines?: (selection: LineSelection) => void;
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

// A selection that ends at the start of a line doesn't include that line.
function selectedLines(
  model: monaco.editor.ITextModel,
  selection: monaco.Selection,
): LineSelection {
  const { startLineNumber: start, endLineNumber, endColumn } = selection;
  const end = endColumn === 1 && endLineNumber > start ? endLineNumber - 1 : endLineNumber;
  const lines = Array.from({ length: end - start + 1 }, (_, index) =>
    model.getLineContent(start + index),
  );
  return { start, end, text: lines.join("\n") };
}

const noZones: readonly EditorZone[] = [];

export function DiffEditor({
  path,
  original,
  modified,
  compact,
  zones = noZones,
  onSelectLines,
}: DiffEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const models = useRef<DiffModels | null>(null);
  const modifiedEditor = useRef<monaco.editor.ICodeEditor | null>(null);
  const selectLines = useRef(onSelectLines);

  useLayoutEffect(() => {
    selectLines.current = onSelectLines;
  });

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
    modifiedEditor.current = editor.getModifiedEditor();
    const selections = editor
      .getModifiedEditor()
      .onDidChangeCursorSelection(({ selection, reason }) => {
        if (reason === monaco.editor.CursorChangeReason.Explicit)
          selectLines.current?.(selectedLines(pair.modified, selection));
      });
    return () => {
      selections.dispose();
      models.current = null;
      modifiedEditor.current = null;
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

  const portals = useViewZones(modifiedEditor, zones, `${path}\n${String(compact)}\n${modified}`);

  return (
    <>
      <div className="monaco-host" ref={host} />
      {portals}
    </>
  );
}
