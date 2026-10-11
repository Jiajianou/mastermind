import { isValidElement, useMemo } from "react";
import type { ReactNode } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import { CodeBlock } from "./CodeBlock.js";

const fenceLanguage = /language-([\w+#.-]+)/;

function fencedCode(children: ReactNode): { code: string; language: string | null } | null {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return null;
  const { className, children: text } = children.props;
  if (typeof text !== "string") return null;
  return {
    code: text.replace(/\n$/, ""),
    language: fenceLanguage.exec(className ?? "")?.[1] ?? null,
  };
}

function replyComponents(streaming: boolean): Components {
  return {
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
    // Replies can echo text from the repo, so an image would let it make the browser fetch any URL unasked.
    img: ({ src, alt }) =>
      typeof src === "string" ? (
        <a href={src} target="_blank" rel="noreferrer">
          {alt === undefined || alt === "" ? src : alt}
        </a>
      ) : null,
    pre: ({ children }) => {
      const fenced = fencedCode(children);
      return fenced === null ? (
        <pre>{children}</pre>
      ) : (
        <CodeBlock code={fenced.code} language={fenced.language} streaming={streaming} />
      );
    },
  };
}

export function Reply({
  text,
  streaming,
  stopped,
}: {
  text: string;
  streaming: boolean;
  stopped: boolean;
}) {
  const components = useMemo(() => replyComponents(streaming), [streaming]);
  return (
    <div className="reply" aria-busy={streaming}>
      <Markdown skipHtml components={components}>
        {text}
      </Markdown>
      {stopped && <p className="muted-line">Stopped</p>}
    </div>
  );
}
