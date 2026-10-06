import { useEffect, useRef } from "react";
import { languageFor, monaco, readOnlyOptions, showText } from "./monaco.js";

export function CodeEditor({ path, text }: { path: string; text: string }) {
  const host = useRef<HTMLDivElement>(null);
  const model = useRef<monaco.editor.ITextModel | null>(null);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    const created = monaco.editor.createModel("", languageFor(path));
    const editor = monaco.editor.create(element, { ...readOnlyOptions, model: created });
    model.current = created;
    return () => {
      model.current = null;
      editor.dispose();
      created.dispose();
    };
  }, [path]);

  useEffect(() => {
    if (model.current !== null) showText(model.current, text);
  }, [path, text]);

  return <div className="monaco-host" ref={host} />;
}
