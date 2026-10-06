import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/features/register.all";
import "./monaco-languages.js";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import { arcticTheme, arcticThemeName, readArcticTokens } from "../theme/monaco-theme.js";

// Only the base editor worker is bundled: the review screens are read-only, so no language service is needed.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.editor.defineTheme(
  arcticThemeName,
  arcticTheme(readArcticTokens(getComputedStyle(document.documentElement))),
);
void document.fonts.ready.then(() => {
  monaco.editor.remeasureFonts();
});

export { monaco };

export function languageFor(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const language = monaco.languages
    .getLanguages()
    .find(
      ({ extensions, filenames }) =>
        filenames?.some((filename) => filename.toLowerCase() === name) === true ||
        extensions?.some((extension) => name.endsWith(extension.toLowerCase())) === true,
    );
  return language?.id ?? "plaintext";
}

export const readOnlyOptions = {
  readOnly: true,
  domReadOnly: true,
  theme: arcticThemeName,
  fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
  fontSize: 13,
  lineHeight: 20,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderLineHighlight: "none",
  contextmenu: false,
} satisfies monaco.editor.IEditorOptions & monaco.editor.IGlobalEditorOptions;

export function showText(model: monaco.editor.ITextModel, text: string): void {
  if (model.getValue() !== text) model.applyEdits([{ range: model.getFullModelRange(), text }]);
}
