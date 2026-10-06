import { useNavigate } from "react-router";
import { Toggle } from "./ReviewToggles.js";

export function SinceToggle({
  round,
  since,
  pathFor,
}: {
  round: number;
  since: string;
  pathFor: (since: string) => string;
}) {
  const navigate = useNavigate();
  const previous = `round:${String(round - 1)}`;
  if (round < 2) return null;
  const options = [
    ["base", "All changes"],
    [previous, `Since round ${String(round - 1)}`],
  ] as const;
  return (
    <Toggle
      label="Changes"
      options={options}
      value={since === previous ? previous : "base"}
      onChange={(value) => {
        void navigate(pathFor(value));
      }}
    />
  );
}
