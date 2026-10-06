import { z } from "zod";
import { isoTimestampSchema, sessionRoleSchema, sessionStatusSchema } from "../contracts/index.js";
import type { Session, SessionRole, SessionStatus } from "../contracts/index.js";
import { RecordNotFoundError } from "./errors.js";
import { insertRow, readRow, readRows, timestamp, updateRow } from "./rows.js";
import type { Columns, DbContext } from "./rows.js";

export interface NewSession {
  role: SessionRole;
  taskId?: string | null;
  round?: number | null;
  attempt?: number | null;
  claudeSessionId?: string | null;
  pid?: number | null;
  pgid?: number | null;
  model?: string | null;
}

export type SessionPatch = Partial<
  Pick<Session, "claudeSessionId" | "pid" | "pgid" | "model" | "inputTokens" | "outputTokens">
>;

export interface SessionEnding {
  status: Exclude<SessionStatus, "running">;
  endCommit?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface SessionRepository {
  create(session: NewSession): Session;
  get(id: number): Session | null;
  listRunning(): Session[];
  listForTask(taskId: string): Session[];
  update(id: number, patch: SessionPatch): Session;
  end(id: number, ending: SessionEnding): Session;
}

const sessionRowSchema = z
  .object({
    id: z.int(),
    task_id: z.string().nullable(),
    role: sessionRoleSchema,
    round: z.int().nullable(),
    attempt: z.int().nullable(),
    claude_session_id: z.string().nullable(),
    pid: z.int().nullable(),
    pgid: z.int().nullable(),
    model: z.string().nullable(),
    status: sessionStatusSchema,
    end_commit: z.string().nullable(),
    input_tokens: z.int().nullable(),
    output_tokens: z.int().nullable(),
    started_at: isoTimestampSchema,
    ended_at: isoTimestampSchema.nullable(),
  })
  .transform((row): Session => ({
    id: row.id,
    taskId: row.task_id,
    role: row.role,
    round: row.round,
    attempt: row.attempt,
    claudeSessionId: row.claude_session_id,
    pid: row.pid,
    pgid: row.pgid,
    model: row.model,
    status: row.status,
    endCommit: row.end_commit,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }));

export function createSessionRepository({ database, clock }: DbContext): SessionRepository {
  const selectSession = database.prepare("SELECT * FROM sessions WHERE id = ?");
  const selectRunning = database.prepare(
    "SELECT * FROM sessions WHERE status = 'running' ORDER BY id",
  );
  const selectForTask = database.prepare("SELECT * FROM sessions WHERE task_id = ? ORDER BY id");

  function get(id: number): Session | null {
    const row = selectSession.get(id);
    return row === undefined ? null : readRow("sessions", sessionRowSchema, row);
  }

  function getExisting(id: number): Session {
    const session = get(id);
    if (session === null) throw new RecordNotFoundError("sessions", id);
    return session;
  }

  function updateExisting(id: number, columns: Columns): Session {
    if (!updateRow(database, "sessions", id, columns))
      throw new RecordNotFoundError("sessions", id);
    return getExisting(id);
  }

  return {
    create(session) {
      const id = insertRow(database, "sessions", {
        task_id: session.taskId ?? null,
        role: session.role,
        round: session.round ?? null,
        attempt: session.attempt ?? null,
        claude_session_id: session.claudeSessionId ?? null,
        pid: session.pid ?? null,
        pgid: session.pgid ?? null,
        model: session.model ?? null,
        status: "running",
        started_at: timestamp(clock),
      });
      return getExisting(id);
    },

    get,

    listRunning() {
      return readRows("sessions", sessionRowSchema, selectRunning.all());
    },

    listForTask(taskId) {
      return readRows("sessions", sessionRowSchema, selectForTask.all(taskId));
    },

    update(id, patch) {
      return updateExisting(id, {
        claude_session_id: patch.claudeSessionId,
        pid: patch.pid,
        pgid: patch.pgid,
        model: patch.model,
        input_tokens: patch.inputTokens,
        output_tokens: patch.outputTokens,
      });
    },

    end(id, ending) {
      return updateExisting(id, {
        status: ending.status,
        end_commit: ending.endCommit,
        input_tokens: ending.inputTokens,
        output_tokens: ending.outputTokens,
        ended_at: timestamp(clock),
      });
    },
  };
}
