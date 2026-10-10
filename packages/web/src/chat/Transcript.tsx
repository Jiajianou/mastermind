import { useEffect, useRef } from "react";
import { DecisionBox } from "./DecisionBox.js";
import { EventLine } from "./EventLine.js";
import { PlanList } from "./PlanList.js";
import { Reply } from "./Reply.js";
import { TurnProgress } from "./TurnProgress.js";
import type { ChatEntry } from "./entries.js";

function Entry({ entry }: { entry: ChatEntry }) {
  switch (entry.kind) {
    case "user":
      return <p className="bubble">{entry.text}</p>;
    case "reply":
      return <Reply text={entry.text} streaming={entry.streaming} stopped={entry.stopped} />;
    case "action":
      return <p className="action-line">{entry.text}</p>;
    case "event":
      return <EventLine ts={entry.ts} text={entry.text} />;
    case "decision":
      return (
        <DecisionBox
          proposalId={entry.proposalId}
          question={entry.question}
          confirmLabel={entry.confirmLabel}
          status={entry.status}
          taskId={entry.taskId}
        />
      );
    case "plan":
      return (
        <PlanList
          planId={entry.planId}
          status={entry.status}
          items={entry.items}
          tasks={entry.tasks}
        />
      );
  }
}

export function Transcript({
  entries,
  progress,
}: {
  entries: ChatEntry[];
  progress: { label: string | null } | null;
}) {
  const end = useRef<HTMLDivElement>(null);
  const last = entries.at(-1);
  const lastText = last?.kind === "reply" ? last.text : null;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [entries.length, lastText, progress?.label]);

  return (
    <div className="transcript" role="log" aria-label="Conversation">
      {entries.map((entry) => (
        <Entry key={entry.key} entry={entry} />
      ))}
      {progress !== null && <TurnProgress label={progress.label} />}
      <div ref={end} />
    </div>
  );
}
