import { DatabaseSync } from "node:sqlite";
import { systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import { createChatRepository, createProposalRepository } from "./chat.js";
import type { ChatRepository, ProposalRepository } from "./chat.js";
import { createCheckRepository } from "./checks.js";
import { createConductorSessionRepository } from "./conductor-sessions.js";
import { createConversationRepository } from "./conversations.js";
import type { ConversationRepository } from "./conversations.js";
import type { ConductorSessionRepository } from "./conductor-sessions.js";
import type { CheckRepository } from "./checks.js";
import { createEventRepository } from "./events.js";
import type { EventRepository } from "./events.js";
import { createFlagRepository } from "./flags.js";
import type { FlagRepository } from "./flags.js";
import { createKillRunning } from "./kill.js";
import type { KilledCounts } from "./kill.js";
import { migrate } from "./migrate.js";
import { createRebaseRepository } from "./rebases.js";
import type { RebaseRepository } from "./rebases.js";
import {
  createCommentRepository,
  createFindingRepository,
  createRoundRepository,
} from "./review.js";
import type { CommentRepository, FindingRepository, RoundRepository } from "./review.js";
import { migrations } from "./schema.js";
import { createSessionRepository } from "./sessions.js";
import type { SessionRepository } from "./sessions.js";
import { createTaskRepository } from "./tasks.js";
import type { TaskRepository } from "./tasks.js";
import { createTransaction } from "./transaction.js";
import { createWipe } from "./wipe.js";
import type { Transaction } from "./transaction.js";

export interface Db {
  tasks: TaskRepository;
  sessions: SessionRepository;
  events: EventRepository;
  checks: CheckRepository;
  rebases: RebaseRepository;
  findings: FindingRepository;
  comments: CommentRepository;
  rounds: RoundRepository;
  conversations: ConversationRepository;
  chat: ChatRepository;
  proposals: ProposalRepository;
  conductorSessions: ConductorSessionRepository;
  flags: FlagRepository;
  transaction: Transaction;
  killRunning(): KilledCounts;
  wipe(): void;
  close(): void;
}

export interface OpenDbOptions {
  clock?: Clock;
}

export function openDb(path: string, options: OpenDbOptions = {}): Db {
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  try {
    database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    const transaction = createTransaction(database);
    migrate(database, transaction, migrations);
    const context = { database, clock: options.clock ?? systemClock, transaction };
    const conversations = createConversationRepository(context);
    return {
      tasks: createTaskRepository(context),
      sessions: createSessionRepository(context),
      events: createEventRepository(context),
      checks: createCheckRepository(context),
      rebases: createRebaseRepository(context),
      findings: createFindingRepository(context),
      comments: createCommentRepository(context),
      rounds: createRoundRepository(context),
      conversations,
      chat: createChatRepository(context, () => conversations.active().id),
      proposals: createProposalRepository(context),
      conductorSessions: createConductorSessionRepository(context),
      flags: createFlagRepository(context),
      transaction,
      killRunning: createKillRunning(context),
      wipe: createWipe(context),
      close: () => {
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
