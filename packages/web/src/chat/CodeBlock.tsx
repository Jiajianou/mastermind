import { useEffect, useState } from "react";

const loadColorize = () => import("./highlight.js").then(({ colorize }) => colorize);

export function CodeBlock({
  code,
  language,
  streaming,
}: {
  code: string;
  language: string | null;
  streaming: boolean;
}) {
  const [colored, setColored] = useState<{ code: string; html: string } | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (language === null || streaming) return;
    let current = true;
    loadColorize()
      .then((colorize) => colorize(code, language))
      .then((html) => {
        if (current) setColored({ code, html });
      })
      .catch((error: unknown) => {
        console.error("could not highlight a code block", error);
      });
    return () => {
      current = false;
    };
  }, [code, language, streaming]);

  const copy = () => {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => {
          setCopied(false);
        }, 1500);
      },
      (error: unknown) => {
        console.error("could not copy the code block", error);
      },
    );
  };

  return (
    <figure className="code-block">
      <figcaption>
        <span>{language ?? "text"}</span>
        <button type="button" className="code-copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </figcaption>
      {colored?.code === code ? (
        // Monaco's colorizer escapes the code and only adds its own token spans.
        <pre dangerouslySetInnerHTML={{ __html: colored.html }} />
      ) : (
        <pre>{code}</pre>
      )}
    </figure>
  );
}
