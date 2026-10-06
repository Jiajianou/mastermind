import type { IsoTimestamp } from "@mastermind/core/contracts";
import { clockTime } from "../components/format.js";

export function EventLine({ ts, text }: { ts: IsoTimestamp; text: string }) {
  return (
    <p className="event-line">
      <time dateTime={ts}>{clockTime(ts)}</time> · {text}
    </p>
  );
}
