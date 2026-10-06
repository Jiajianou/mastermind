import Markdown from "react-markdown";
import type { Components } from "react-markdown";

const components: Components = {
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
};

export function Reply({
  text,
  streaming,
  stopped,
}: {
  text: string;
  streaming: boolean;
  stopped: boolean;
}) {
  return (
    <div className="reply" aria-busy={streaming}>
      <Markdown skipHtml components={components}>
        {text}
      </Markdown>
      {stopped && <p className="muted-line">Stopped</p>}
    </div>
  );
}
