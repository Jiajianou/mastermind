import type { Round, Task } from "@mastermind/core/contracts";
import { clockTime } from "../components/format.js";
import { count } from "../notes/notes.js";

const modeWords = { resume: "Continued the same session", fresh: "Started a fresh session" };

function sentWords(round: Round): string {
  const parts = [
    ...(round.commentIds.length > 0 ? [count(round.commentIds.length, "comment")] : []),
    ...(round.findingIds.length > 0 ? [count(round.findingIds.length, "finding")] : []),
    ...(round.failingCheckId === null ? [] : ["the failing check"]),
  ];
  return parts.length === 0 ? "an instruction" : parts.join(", ");
}

export function RoundsHistory({ task, rounds }: { task: Task; rounds: readonly Round[] }) {
  return (
    <section className="rounds-history panel" aria-label="Rounds">
      <h2>Rounds</h2>
      <ol>
        <li>
          <span className="round-name">Round 1</span>
          <span className="muted">The first run of the task</span>
        </li>
        {rounds.map((round) => (
          <li key={round.id}>
            <span className="round-name">Round {round.round}</span>
            <span className="muted">
              {modeWords[round.mode]} at {clockTime(round.createdAt)} · sent {sentWords(round)}
            </span>
            {round.instruction !== "" && (
              <span className="round-instruction">{round.instruction}</span>
            )}
          </li>
        ))}
        <li aria-current="step">
          <span className="round-name">Round {task.round + 1}</span>
          <span className="muted">This request</span>
        </li>
      </ol>
    </section>
  );
}
