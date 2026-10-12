import type { DiffLineKind } from "@mastermind/core/contracts";
import { Reply } from "../chat/Reply.js";
import { useNow } from "../components/use-now.js";
import type { LiveActivity } from "../store/state.js";
import { durationText } from "./duration.js";
import { hiddenLinesNote, startingTool } from "./transcript.js";
import type { ToolDetail, ToolStatus, TranscriptEntry } from "./transcript.js";

type ToolEntry = Extract<TranscriptEntry, { kind: "tool" }>;

const statusWords: Record<ToolStatus, string> = {
  running: "in progress",
  done: "done",
  failed: "failed",
  unfinished: "not finished",
};

const diffMarks: Record<DiffLineKind, string> = { same: " ", added: "+", removed: "-" };

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

function DetailView({ detail }: { detail: ToolDetail }) {
  switch (detail.kind) {
    case "diff":
      return (
        <pre className="step-detail tool-diff">
          {detail.lines.map((line, index) => (
            <span key={index} className={`diff-line diff-${line.kind}`}>
              <span className="diff-number">{line.number ?? ""}</span>
              {diffMarks[line.kind]} {line.text}
              {"\n"}
            </span>
          ))}
          {detail.hidden > 0 && <span className="diff-line">{hiddenLinesNote(detail.hidden)}</span>}
        </pre>
      );
    case "todos":
      return (
        <ul className="todo-list" aria-label="Todos">
          {detail.todos.map((todo, index) => (
            <li key={index} className={`todo-${todo.status}`}>
              <span aria-hidden="true">{todo.status === "completed" ? "☒" : "☐"} </span>
              {todo.content}
              {todo.status === "in_progress" && (
                <span className="visually-hidden"> (in progress)</span>
              )}
              {todo.status === "completed" && <span className="visually-hidden"> (done)</span>}
            </li>
          ))}
        </ul>
      );
    case "output":
      return <pre className="step-detail">{detail.text}</pre>;
    case "none":
      return null;
  }
}

function ToolStep({ entry, compact }: { entry: ToolEntry; compact: boolean }) {
  const { detail } = entry;
  const expandable = !compact && (detail.kind === "diff" || detail.kind === "output");
  const heading = (
    <>
      <span className={`step-mark step-${entry.status}`} aria-hidden="true">
        ●
      </span>
      <span className="tool-name">{entry.name}</span>
      {entry.target !== "" && <code className="tool-target">{entry.target}</code>}
      {expandable && (
        <span className="step-toggle" aria-hidden="true">
          ▸
        </span>
      )}
      <span className="visually-hidden"> ({statusWords[entry.status]})</span>
      {entry.result !== null && <span className="tool-result">{entry.result}</span>}
    </>
  );
  if (!expandable)
    return (
      <div className="step tool-step">
        <p className="tool-heading">{heading}</p>
        {!compact && <DetailView detail={detail} />}
      </div>
    );
  return (
    <details className="step tool-step">
      <summary>{heading}</summary>
      <DetailView detail={detail} />
    </details>
  );
}

function PromptEntry({
  entry,
  compact,
}: {
  entry: Extract<TranscriptEntry, { kind: "prompt" }>;
  compact: boolean;
}) {
  if (entry.fromOwner)
    return <p className="bubble">{compact ? firstLine(entry.text) : entry.text}</p>;
  if (compact) return <p className="transcript-prompt">› {firstLine(entry.text)}</p>;
  return (
    <details className="transcript-prompt">
      <summary>
        › {firstLine(entry.text)}
        <span className="step-toggle" aria-hidden="true">
          ▸
        </span>
      </summary>
      <pre className="step-detail">{entry.text}</pre>
    </details>
  );
}

function Entry({ entry, compact }: { entry: TranscriptEntry; compact: boolean }) {
  switch (entry.kind) {
    case "prompt":
      return <PromptEntry entry={entry} compact={compact} />;
    case "text":
      return compact ? (
        <p className="transcript-text">{firstLine(entry.text)}</p>
      ) : (
        <Reply text={entry.text} streaming={false} stopped={false} />
      );
    case "tool":
      return <ToolStep entry={entry} compact={compact} />;
    case "notice":
      return (
        <p className={entry.failed ? "transcript-notice failure" : "transcript-notice"}>
          {entry.text}
        </p>
      );
  }
}

function tokenCount(tokens: number): string {
  return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}

function SessionProgress({ since, live }: { since: string; live: LiveActivity | null }) {
  const now = useNow();
  const thinking = live?.kind === "thinking";
  const elapsed = durationText(now.getTime() - Date.parse(since));
  const tokens = thinking && live.tokens > 0 ? ` · ↓ ${tokenCount(live.tokens)} tokens` : "";
  return (
    <p className="turn-progress" role="status">
      <span className="turn-spinner" aria-hidden="true">
        ✻
      </span>
      <span>{thinking ? "Thinking…" : "Working…"}</span>
      <span className="turn-elapsed" aria-hidden="true">
        ({elapsed}
        {tokens})
      </span>
    </p>
  );
}

function StreamingText({ text, compact }: { text: string; compact: boolean }) {
  if (compact) return <p className="transcript-text">{firstLine(text)}</p>;
  return <Reply text={text} streaming stopped={false} />;
}

export function SessionTranscript({
  entries,
  workingSince,
  live,
  compact = false,
}: {
  entries: readonly TranscriptEntry[];
  workingSince: string | null;
  live: LiveActivity | null;
  compact?: boolean;
}) {
  const streaming = workingSince !== null && live?.kind === "text" ? live.text : null;
  const starting = workingSince !== null && live?.kind === "tool" ? startingTool(live.name) : null;
  return (
    <>
      <ol className={compact ? "session-transcript compact" : "session-transcript"}>
        {entries.map((entry) => (
          <li
            key={entry.key}
            className="transcript-entry"
            aria-current={entry.kind === "tool" && entry.status === "running" ? "step" : undefined}
          >
            <Entry entry={entry} compact={compact} />
          </li>
        ))}
        {starting !== null && (
          <li className="transcript-entry" aria-current="step">
            <ToolStep entry={starting} compact={compact} />
          </li>
        )}
        {streaming !== null && (
          <li className="transcript-entry" aria-busy="true">
            <StreamingText text={streaming} compact={compact} />
          </li>
        )}
      </ol>
      {workingSince !== null && <SessionProgress since={workingSince} live={live} />}
    </>
  );
}
