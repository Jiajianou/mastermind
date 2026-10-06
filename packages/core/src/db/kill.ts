import { changedRows, timestamp } from "./rows.js";
import type { DbContext } from "./rows.js";

export interface KilledCounts {
  sessions: number;
  checks: number;
  rebases: number;
}

// The chat's own process is killed too, but it is not one of the sessions the terminal lists, so it isn't counted.
export function createKillRunning({ database, clock, transaction }: DbContext): () => KilledCounts {
  const killConductor = database.prepare(
    "UPDATE sessions SET status = 'killed', ended_at = ? WHERE status = 'running' AND role = 'conductor'",
  );
  const killTaskSessions = database.prepare(
    "UPDATE sessions SET status = 'killed', ended_at = ? WHERE status = 'running' AND role != 'conductor'",
  );
  const killChecks = database.prepare(
    "UPDATE checks SET status = 'killed' WHERE status = 'running'",
  );
  const killRebases = database.prepare(
    "UPDATE rebases SET status = 'killed' WHERE status = 'running'",
  );

  return () =>
    transaction(() => {
      const endedAt = timestamp(clock);
      killConductor.run(endedAt);
      return {
        sessions: changedRows(killTaskSessions.run(endedAt)),
        checks: changedRows(killChecks.run()),
        rebases: changedRows(killRebases.run()),
      };
    });
}
