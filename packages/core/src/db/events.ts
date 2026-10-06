import { z } from "zod";
import { eventTypeSchema, isoTimestampSchema } from "../contracts/index.js";
import type { EventType, SessionEvent } from "../contracts/index.js";
import { insertRow, readRow, readRows, timestamp } from "./rows.js";
import type { DbContext } from "./rows.js";

export interface NewSessionEvent {
  sessionId: number;
  type: EventType;
  summary: string;
  payload: string;
}

export interface EventRepository {
  append(event: NewSessionEvent): SessionEvent;
  listForSession(sessionId: number, options?: { afterId?: number }): SessionEvent[];
}

const eventRowSchema = z
  .object({
    id: z.int(),
    session_id: z.int(),
    ts: isoTimestampSchema,
    type: eventTypeSchema,
    summary: z.string(),
    payload: z.string(),
  })
  .transform((row): SessionEvent => ({
    id: row.id,
    sessionId: row.session_id,
    ts: row.ts,
    type: row.type,
    summary: row.summary,
    payload: row.payload,
  }));

export function createEventRepository({ database, clock }: DbContext): EventRepository {
  const selectEvent = database.prepare("SELECT * FROM events WHERE id = ?");
  const selectForSession = database.prepare(
    "SELECT * FROM events WHERE session_id = ? AND id > ? ORDER BY id",
  );

  return {
    append(event) {
      const id = insertRow(database, "events", {
        session_id: event.sessionId,
        ts: timestamp(clock),
        type: event.type,
        summary: event.summary,
        payload: event.payload,
      });
      return readRow("events", eventRowSchema, selectEvent.get(id));
    },

    listForSession(sessionId, options = {}) {
      return readRows(
        "events",
        eventRowSchema,
        selectForSession.all(sessionId, options.afterId ?? 0),
      );
    },
  };
}
