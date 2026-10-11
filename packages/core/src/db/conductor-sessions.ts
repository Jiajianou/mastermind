import { z } from "zod";
import { isoTimestampSchema } from "../contracts/index.js";
import type { ConductorSession } from "../contracts/index.js";
import { RecordNotFoundError } from "./errors.js";
import { insertRow, readRow, timestamp, updateRow } from "./rows.js";
import type { Columns, DbContext } from "./rows.js";

export interface ConductorSessionRepository {
  open(id: string, conversationId: number): ConductorSession;
  latest(conversationId: number): ConductorSession | null;
  latestSummary(conversationId: number): string | null;
  setTokens(id: string, tokens: number): ConductorSession;
  end(id: string, summary?: string): ConductorSession;
}

const conductorSessionRowSchema = z
  .object({
    id: z.string(),
    conversation_id: z.int().nullable(),
    started_at: isoTimestampSchema,
    ended_at: isoTimestampSchema.nullable(),
    summary: z.string().nullable(),
    tokens: z.int().nullable(),
  })
  .transform((row): ConductorSession => ({
    id: row.id,
    conversationId: row.conversation_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    summary: row.summary,
    tokens: row.tokens,
  }));

export function createConductorSessionRepository({
  database,
  clock,
}: DbContext): ConductorSessionRepository {
  const selectSession = database.prepare("SELECT * FROM conductor_sessions WHERE id = ?");
  const selectLatest = database.prepare(
    "SELECT * FROM conductor_sessions WHERE conversation_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
  );
  const selectLatestSummary = database.prepare(
    "SELECT * FROM conductor_sessions WHERE conversation_id = ? AND summary IS NOT NULL ORDER BY ended_at DESC, rowid DESC LIMIT 1",
  );

  function getExisting(id: string): ConductorSession {
    const row = selectSession.get(id);
    if (row === undefined) throw new RecordNotFoundError("conductor_sessions", id);
    return readRow("conductor_sessions", conductorSessionRowSchema, row);
  }

  function update(id: string, columns: Columns): ConductorSession {
    if (!updateRow(database, "conductor_sessions", id, columns))
      throw new RecordNotFoundError("conductor_sessions", id);
    return getExisting(id);
  }

  return {
    open(id, conversationId) {
      insertRow(database, "conductor_sessions", {
        id,
        conversation_id: conversationId,
        started_at: timestamp(clock),
      });
      return getExisting(id);
    },

    latest(conversationId) {
      const row = selectLatest.get(conversationId);
      return row === undefined
        ? null
        : readRow("conductor_sessions", conductorSessionRowSchema, row);
    },

    latestSummary(conversationId) {
      const row = selectLatestSummary.get(conversationId);
      return row === undefined
        ? null
        : readRow("conductor_sessions", conductorSessionRowSchema, row).summary;
    },

    setTokens: (id, tokens) => update(id, { tokens }),

    end: (id, summary) => update(id, { ended_at: timestamp(clock), summary }),
  };
}
