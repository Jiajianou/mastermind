import { z } from "zod";
import { isoTimestampSchema } from "../contracts/index.js";
import type { Conversation } from "../contracts/index.js";
import { RecordNotFoundError } from "./errors.js";
import { insertRow, readRow, readRows, timestamp, updateRow } from "./rows.js";
import type { DbContext } from "./rows.js";

export interface ConversationRepository {
  create(): Conversation;
  open(id: number): Conversation;
  active(): Conversation;
  get(id: number): Conversation | null;
  list(): Conversation[];
  setTitle(id: number, title: string): Conversation;
}

const conversationRowSchema = z
  .object({
    id: z.int(),
    title: z.string().nullable(),
    started_at: isoTimestampSchema,
    last_activity_at: isoTimestampSchema,
  })
  .transform((row): Conversation => ({
    id: row.id,
    title: row.title,
    startedAt: row.started_at,
    lastActivityAt: row.last_activity_at,
  }));

const selectColumns = `SELECT c.id, c.title, c.started_at,
  COALESCE((SELECT MAX(m.ts) FROM chat_messages AS m WHERE m.conversation_id = c.id), c.started_at)
    AS last_activity_at
  FROM conversations AS c`;

// The active conversation is the one opened last; `opened` counts up so that two opens in the same millisecond
// still have an order.
export function createConversationRepository({
  database,
  clock,
}: DbContext): ConversationRepository {
  const selectOne = database.prepare(`${selectColumns} WHERE c.id = ?`);
  const selectAll = database.prepare(`${selectColumns} ORDER BY last_activity_at DESC, c.id DESC`);
  const selectActive = database.prepare(
    "SELECT id FROM conversations ORDER BY opened DESC LIMIT 1",
  );
  const nextOpened = "(SELECT COALESCE(MAX(opened), 0) + 1 FROM conversations)";
  const markOpened = database.prepare(
    `UPDATE conversations SET opened = ${nextOpened} WHERE id = ?`,
  );
  const activeRowSchema = z.object({ id: z.int() });

  function getExisting(id: number): Conversation {
    const row = selectOne.get(id);
    if (row === undefined) throw new RecordNotFoundError("conversations", id);
    return readRow("conversations", conversationRowSchema, row);
  }

  function create(): Conversation {
    const id = insertRow(database, "conversations", { started_at: timestamp(clock), opened: 0 });
    markOpened.run(id);
    return getExisting(id);
  }

  return {
    create,

    open(id) {
      if (Number(markOpened.run(id).changes) === 0)
        throw new RecordNotFoundError("conversations", id);
      return getExisting(id);
    },

    active() {
      const row = selectActive.get();
      return row === undefined
        ? create()
        : getExisting(readRow("conversations", activeRowSchema, row).id);
    },

    get(id) {
      const row = selectOne.get(id);
      return row === undefined ? null : readRow("conversations", conversationRowSchema, row);
    },

    list: () => readRows("conversations", conversationRowSchema, selectAll.all()),

    setTitle(id, title) {
      if (!updateRow(database, "conversations", id, { title }))
        throw new RecordNotFoundError("conversations", id);
      return getExisting(id);
    },
  };
}
