import type { Session } from "@mastermind/core/contracts";
import { useNow } from "../components/use-now.js";
import { elapsedText } from "./duration.js";

export function Elapsed({ session }: { session: Pick<Session, "startedAt" | "endedAt"> }) {
  const now = useNow();
  return <span className="elapsed">{elapsedText(session, now)}</span>;
}
