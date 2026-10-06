import type { editor } from "monaco-editor/editor/editor.api";

export interface ArcticTokens {
  page: string;
  panel: string;
  raised: string;
  panelBorder: string;
  controlBorder: string;
  text: string;
  textMuted: string;
  frost: string;
  addedLine: string;
  peach: string;
  removedLine: string;
}

export function readArcticTokens(style: CSSStyleDeclaration): ArcticTokens {
  const read = (name: string): string => style.getPropertyValue(`--color-${name}`).trim();
  return {
    page: read("page"),
    panel: read("panel"),
    raised: read("raised"),
    panelBorder: read("panel-border"),
    controlBorder: read("control-border"),
    text: read("text"),
    textMuted: read("text-muted"),
    frost: read("frost"),
    addedLine: read("added-line"),
    peach: read("peach"),
    removedLine: read("removed-line"),
  };
}

export const arcticThemeName = "arctic";

const translucent = (hex: string, alpha: string): string => `${hex}${alpha}`;
const tokenColor = (hex: string): string => hex.replace("#", "");

export function arcticTheme(tokens: ArcticTokens): editor.IStandaloneThemeData {
  return {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: tokenColor(tokens.text) },
      { token: "comment", foreground: tokenColor(tokens.textMuted), fontStyle: "italic" },
      { token: "keyword", foreground: tokenColor(tokens.frost) },
      { token: "type", foreground: tokenColor(tokens.frost) },
    ],
    colors: {
      "editor.background": tokens.panel,
      "editor.foreground": tokens.text,
      "editorGutter.background": tokens.panel,
      "editorLineNumber.foreground": tokens.textMuted,
      "editorLineNumber.activeForeground": tokens.text,
      "editor.lineHighlightBackground": tokens.raised,
      "editor.selectionBackground": tokens.controlBorder,
      "editor.inactiveSelectionBackground": tokens.raised,
      "editorIndentGuide.background1": tokens.panelBorder,
      "editorWidget.background": tokens.panel,
      "editorWidget.border": tokens.panelBorder,
      focusBorder: tokens.frost,
      "scrollbarSlider.background": translucent(tokens.controlBorder, "80"),
      "scrollbarSlider.hoverBackground": tokens.controlBorder,
      "diffEditor.insertedLineBackground": tokens.addedLine,
      "diffEditor.removedLineBackground": tokens.removedLine,
      "diffEditor.insertedTextBackground": translucent(tokens.frost, "40"),
      "diffEditor.removedTextBackground": translucent(tokens.peach, "40"),
      "diffEditorGutter.insertedLineBackground": tokens.addedLine,
      "diffEditorGutter.removedLineBackground": tokens.removedLine,
      "diffEditor.border": tokens.panelBorder,
      "diffEditor.diagonalFill": tokens.panelBorder,
      "diffEditor.unchangedRegionBackground": tokens.page,
      "diffEditor.unchangedRegionForeground": tokens.textMuted,
    },
  };
}
