import type { Check } from "@mastermind/core/contracts";
import type { ReactNode } from "react";
import { checkNames } from "../decide/checks.js";
import { lineRange } from "../notes/notes.js";
import type { RoundNotes } from "../notes/notes.js";
import { commentKey, findingKey, isIncluded } from "./request.js";
import type { Included, SendKey } from "./request.js";

function Item({
  sendKey,
  included,
  onToggle,
  kind,
  children,
}: {
  sendKey: SendKey;
  included: Included;
  onToggle: (key: SendKey, on: boolean) => void;
  kind: string;
  children: ReactNode;
}) {
  return (
    <li>
      <label className="send-item">
        <input
          type="checkbox"
          checked={isIncluded(included, sendKey)}
          onChange={(event) => {
            onToggle(sendKey, event.target.checked);
          }}
        />
        <span className="send-kind">{kind}</span>
        <span className="send-detail">{children}</span>
      </label>
    </li>
  );
}

export function WhatToSend({
  notes,
  failing,
  included,
  onToggle,
}: {
  notes: RoundNotes;
  failing: Check | null;
  included: Included;
  onToggle: (key: SendKey, on: boolean) => void;
}) {
  const empty = notes.comments.length === 0 && notes.findings.length === 0 && failing === null;
  return (
    <fieldset className="what-to-send">
      <legend>What to send</legend>
      {empty ? (
        <p className="muted">
          No comments or findings in this round. Add comments on the diff, or write an instruction.
        </p>
      ) : (
        <ul>
          {notes.comments.map((comment) => (
            <Item
              key={comment.id}
              sendKey={commentKey(comment.id)}
              included={included}
              onToggle={onToggle}
              kind="Comment"
            >
              <code>
                {comment.file}, {lineRange(comment.lineStart, comment.lineEnd)}
              </code>{" "}
              {comment.text}
            </Item>
          ))}
          {notes.findings.map((finding) => (
            <Item
              key={finding.id}
              sendKey={findingKey(finding.id)}
              included={included}
              onToggle={onToggle}
              kind={finding.severity === "serious" ? "Serious finding" : "Minor finding"}
            >
              <code>
                {finding.file}
                {finding.line === null ? "" : `, ${lineRange(finding.line, finding.line)}`}
              </code>{" "}
              {finding.text}
            </Item>
          ))}
          {failing !== null && (
            <Item sendKey="failing" included={included} onToggle={onToggle} kind="Failing check">
              {checkNames[failing.kind]}
              {failing.summary === null ? "" : `: ${failing.summary}`}
            </Item>
          )}
        </ul>
      )}
    </fieldset>
  );
}
