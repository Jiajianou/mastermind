import { z } from "zod";
import {
  chatMessageKindSchema,
  isoTimestampSchema,
  jsonValueSchema,
  proposalStatusSchema,
} from "../contracts/index.js";
import type {
  ChatMessage,
  ChatMessageKind,
  JsonValue,
  Proposal,
  ProposalStatus,
} from "../contracts/index.js";
import { ProposalAlreadyDecidedError, RecordNotFoundError } from "./errors.js";
import {
  changedRows,
  insertRow,
  jsonColumn,
  readRow,
  readRows,
  timestamp,
  toJsonText,
} from "./rows.js";
import type { DbContext } from "./rows.js";

export interface NewChatMessage {
  kind: ChatMessageKind;
  content: string;
  meta?: JsonValue;
  conductorSession?: string | null;
  turnId?: string | null;
}

export interface NewProposal {
  action: string;
  args: JsonValue;
}

export interface ChatRepository {
  append(message: NewChatMessage): ChatMessage;
  get(id: number): ChatMessage | null;
  list(afterId?: number): ChatMessage[];
  listForConversation(conductorSession: string): ChatMessage[];
}

export interface ProposalRepository {
  create(proposal: NewProposal): Proposal;
  get(id: number): Proposal | null;
  listPending(): Proposal[];
  listForAction(action: string): Proposal[];
  decide(id: number, status: Exclude<ProposalStatus, "pending">, result?: JsonValue): Proposal;
}

const optionalJsonColumn = jsonColumn(jsonValueSchema).nullable();

const chatMessageRowSchema = z
  .object({
    id: z.int(),
    ts: isoTimestampSchema,
    kind: chatMessageKindSchema,
    content: z.string(),
    meta: optionalJsonColumn,
    conductor_session: z.string().nullable(),
    turn_id: z.string().nullable(),
  })
  .transform((row): ChatMessage => ({
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    content: row.content,
    meta: row.meta,
    conductorSession: row.conductor_session,
    turnId: row.turn_id,
  }));

const proposalRowSchema = z
  .object({
    id: z.int(),
    ts: isoTimestampSchema,
    action: z.string(),
    args: jsonColumn(jsonValueSchema),
    status: proposalStatusSchema,
    decided_at: isoTimestampSchema.nullable(),
    result: optionalJsonColumn,
  })
  .transform((row): Proposal => ({
    id: row.id,
    ts: row.ts,
    action: row.action,
    args: row.args,
    status: row.status,
    decidedAt: row.decided_at,
    result: row.result,
  }));

export function createChatRepository({ database, clock }: DbContext): ChatRepository {
  const selectMessage = database.prepare("SELECT * FROM chat_messages WHERE id = ?");
  const selectMessages = database.prepare("SELECT * FROM chat_messages WHERE id > ? ORDER BY id");
  // A message sent while a rollover runs is stored under the old conversation, but its turn belongs to the new one.
  const selectConversation = database.prepare(
    `SELECT * FROM chat_messages
      WHERE conductor_session = :id
         OR turn_id IN (SELECT turn_id FROM chat_messages WHERE conductor_session = :id AND turn_id IS NOT NULL)
      ORDER BY id`,
  );

  return {
    append(message) {
      const id = insertRow(database, "chat_messages", {
        ts: timestamp(clock),
        kind: message.kind,
        content: message.content,
        meta: toJsonText(message.meta ?? null),
        conductor_session: message.conductorSession ?? null,
        turn_id: message.turnId ?? null,
      });
      return readRow("chat_messages", chatMessageRowSchema, selectMessage.get(id));
    },

    get(id) {
      const row = selectMessage.get(id);
      return row === undefined ? null : readRow("chat_messages", chatMessageRowSchema, row);
    },

    list(afterId = 0) {
      return readRows("chat_messages", chatMessageRowSchema, selectMessages.all(afterId));
    },

    listForConversation(conductorSession) {
      return readRows(
        "chat_messages",
        chatMessageRowSchema,
        selectConversation.all({ id: conductorSession }),
      );
    },
  };
}

export function createProposalRepository({ database, clock }: DbContext): ProposalRepository {
  const selectProposal = database.prepare("SELECT * FROM proposals WHERE id = ?");
  const selectPending = database.prepare(
    "SELECT * FROM proposals WHERE status = 'pending' ORDER BY id",
  );
  const selectForAction = database.prepare("SELECT * FROM proposals WHERE action = ? ORDER BY id");
  const decidePending = database.prepare(
    "UPDATE proposals SET status = ?, decided_at = ?, result = ? WHERE id = ? AND status = 'pending'",
  );

  function get(id: number): Proposal | null {
    const row = selectProposal.get(id);
    return row === undefined ? null : readRow("proposals", proposalRowSchema, row);
  }

  return {
    create(proposal) {
      const id = insertRow(database, "proposals", {
        ts: timestamp(clock),
        action: proposal.action,
        args: JSON.stringify(proposal.args),
        status: "pending",
      });
      return readRow("proposals", proposalRowSchema, selectProposal.get(id));
    },

    get,

    listPending() {
      return readRows("proposals", proposalRowSchema, selectPending.all());
    },

    listForAction(action) {
      return readRows("proposals", proposalRowSchema, selectForAction.all(action));
    },

    decide(id, status, result = null) {
      const changes = changedRows(
        decidePending.run(status, timestamp(clock), toJsonText(result), id),
      );
      const proposal = get(id);
      if (proposal === null) throw new RecordNotFoundError("proposals", id);
      if (changes === 0) throw new ProposalAlreadyDecidedError(id, proposal.status);
      return proposal;
    },
  };
}
