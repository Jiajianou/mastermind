import { monaco } from "../review/monaco.js";
import { arcticThemeName } from "../theme/monaco-theme.js";

function languageId(fence: string): string {
  const name = fence.toLowerCase();
  const language = monaco.languages
    .getLanguages()
    .find(
      ({ id, aliases, extensions }) =>
        id === name ||
        aliases?.some((alias) => alias.toLowerCase() === name) === true ||
        extensions?.includes(`.${name}`) === true,
    );
  return language?.id ?? "plaintext";
}

export function colorize(code: string, fence: string): Promise<string> {
  monaco.editor.setTheme(arcticThemeName);
  return monaco.editor.colorize(code, languageId(fence), { tabSize: 2 });
}
