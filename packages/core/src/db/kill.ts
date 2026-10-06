import { changedRows, timestamp } from "./rows.js";
import type { DbContext } from "./rows.js";

export interface KilledCounts {
  sessions: number;
  checks: number;
  rebases: number;
}

export function createKillRunning({ database, clock, transaction }: DbContext): () => KilledCounts {
  const killSessions = database.prepare(
    "UPDATE sessions SET status = 'killed', ended_at = ? WHERE status = 'running'",
  );
  const killChecks = database.prepare(
    "UPDATE checks SET status = 'killed' WHERE status = 'running'",
  );
  const killRebases = database.prepare(
    "UPDATE rebases SET status = 'killed' WHERE status = 'running'",
  );

  return () =>
    transaction(() => ({
      sessions: changedRows(killSessions.run(timestamp(clock))),
      checks: changedRows(killChecks.run()),
      rebases: changedRows(killRebases.run()),
    }));
}
