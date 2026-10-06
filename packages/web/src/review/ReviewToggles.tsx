import { useNavigate } from "react-router";
import { reviewPath } from "./location.js";
import type { ReviewLocation } from "./location.js";

interface ToggleProps<Value extends string> {
  label: string;
  options: readonly (readonly [Value, string])[];
  value: Value;
  onChange: (value: Value) => void;
}

export function Toggle<Value extends string>({
  label,
  options,
  value,
  onChange,
}: ToggleProps<Value>) {
  return (
    <div className="toggle" role="group" aria-label={label}>
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => {
            onChange(option);
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

const modes = [
  ["diff", "Diff"],
  ["file", "File"],
] as const;

const views = [
  ["one", "One"],
  ["all", "All"],
] as const;

export function ReviewToggles({ location }: { location: ReviewLocation }) {
  const navigate = useNavigate();
  return (
    <div className="review-toggles">
      {location.view === "one" && (
        <Toggle
          label="Show"
          options={modes}
          value={location.mode}
          onChange={(mode) => {
            void navigate(reviewPath({ ...location, mode }));
          }}
        />
      )}
      <Toggle
        label="Sessions"
        options={views}
        value={location.view}
        onChange={(view) => {
          void navigate(reviewPath({ ...location, view }));
        }}
      />
    </div>
  );
}
