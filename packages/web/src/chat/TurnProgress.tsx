import { useEffect, useState } from "react";
import { elapsedText } from "./elapsed.js";

const tickMs = 1000;

export function TurnProgress({ label }: { label: string }) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, tickMs);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return (
    <p className="turn-progress" role="status">
      <span className="turn-spinner" aria-hidden="true">
        ✻
      </span>
      <span>{label}…</span>
      <span className="turn-elapsed" aria-hidden="true">
        ({elapsedText(now - startedAt)})
      </span>
    </p>
  );
}
