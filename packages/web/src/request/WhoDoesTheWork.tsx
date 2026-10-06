import type { RoundMode } from "@mastermind/core/contracts";

const choices: readonly { mode: RoundMode; label: string; hint: string }[] = [
  {
    mode: "resume",
    label: "Continue the same session",
    hint: "Keeps what the session learned. Suits small follow-ups.",
  },
  {
    mode: "fresh",
    label: "Start a fresh session",
    hint: "A new worker reads the task, a summary of the diff and this message. Suits work that went the wrong way.",
  },
];

export function WhoDoesTheWork({
  mode,
  onChange,
}: {
  mode: RoundMode;
  onChange: (mode: RoundMode) => void;
}) {
  return (
    <fieldset className="who-does-the-work">
      <legend>Who does the work</legend>
      {choices.map((choice) => (
        <label key={choice.mode} className="work-choice">
          <input
            type="radio"
            name="mode"
            value={choice.mode}
            checked={mode === choice.mode}
            onChange={() => {
              onChange(choice.mode);
            }}
          />
          <span>
            <span className="work-label">{choice.label}</span>
            <span className="muted work-hint">{choice.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
