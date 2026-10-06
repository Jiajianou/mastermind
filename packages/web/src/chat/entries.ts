import {
  planMetaSchema,
  planStartedMetaSchema,
  proposalMetaSchema,
  setupMetaSchema,
} from "@mastermind/core/contracts";
import type {
  ChatMessage,
  IsoTimestamp,
  PlanMeta,
  Proposal,
  ProposalStatus,
} from "@mastermind/core/contracts";
import { z } from "zod";
import type { ChatState } from "../store/state.js";

export interface PlanItem {
  id: string;
  note: string;
}

export type PlanStatus = "ready" | "started" | "replaced";

export type ChatEntry =
  | { kind: "user"; key: string; text: string }
  | { kind: "reply"; key: string; text: string; streaming: boolean; stopped: boolean }
  | { kind: "action"; key: string; text: string }
  | { kind: "event"; key: string; ts: IsoTimestamp; text: string }
  | {
      kind: "decision";
      key: string;
      proposalId: number;
      question: string;
      confirmLabel: string | null;
      status: ProposalStatus;
      taskId: string | null;
    }
  | {
      kind: "plan";
      key: string;
      planId: number;
      status: PlanStatus;
      items: PlanItem[];
      tasks: PlanMeta["tasks"];
    };

export type Proposals = Readonly<Record<number, Proposal>>;

const stoppedMetaSchema = z.object({ stopped: z.literal(true) });

const key = (message: ChatMessage): string => `message-${String(message.id)}`;

function decidedStatuses(messages: readonly ChatMessage[]): Map<number, ProposalStatus> {
  const statuses = new Map<number, ProposalStatus>();
  for (const message of messages) {
    if (message.kind !== "system") continue;
    const meta = proposalMetaSchema.safeParse(message.meta);
    if (meta.success && meta.data.status !== undefined)
      statuses.set(meta.data.proposalId, meta.data.status);
  }
  return statuses;
}

interface PlanHistory {
  latest: number | null;
  started: ReadonlySet<number>;
}

const startedPlanId = (message: ChatMessage): number | null => {
  if (message.kind !== "system") return null;
  const meta = planStartedMetaSchema.safeParse(message.meta);
  return meta.success ? meta.data.planId : null;
};

function planHistory(messages: readonly ChatMessage[]): PlanHistory {
  const started = new Set<number>();
  let latest: number | null = null;
  for (const message of messages) {
    if (message.kind === "plan" && planMetaSchema.safeParse(message.meta).success)
      latest = message.id;
    const planId = startedPlanId(message);
    if (planId !== null) started.add(planId);
  }
  return { latest, started };
}

function planStatus(planId: number, history: PlanHistory): PlanStatus {
  if (history.started.has(planId)) return "started";
  return planId === history.latest ? "ready" : "replaced";
}

function decisionEntry(
  message: ChatMessage,
  proposals: Proposals,
  decided: ReadonlyMap<number, ProposalStatus>,
): ChatEntry {
  const meta = proposalMetaSchema.safeParse(message.meta);
  if (!meta.success)
    return { kind: "event", key: key(message), ts: message.ts, text: message.content };
  const { proposalId, taskId, confirmLabel } = meta.data;
  return {
    kind: "decision",
    key: key(message),
    proposalId,
    question: message.content,
    confirmLabel: confirmLabel ?? null,
    status: proposals[proposalId]?.status ?? decided.get(proposalId) ?? "pending",
    taskId: taskId ?? null,
  };
}

function planEntry(message: ChatMessage, history: PlanHistory): ChatEntry {
  const meta = planMetaSchema.safeParse(message.meta);
  if (!meta.success)
    return {
      kind: "reply",
      key: key(message),
      text: message.content,
      streaming: false,
      stopped: false,
    };
  const { tasks, notes } = meta.data;
  const items = tasks.map(({ id, title }) => ({ id, note: notes[id] ?? title }));
  return {
    kind: "plan",
    key: key(message),
    planId: message.id,
    status: planStatus(message.id, history),
    items,
    tasks,
  };
}

interface History {
  proposals: Proposals;
  decided: ReadonlyMap<number, ProposalStatus>;
  plans: PlanHistory;
}

function messageEntry(message: ChatMessage, { proposals, decided, plans }: History): ChatEntry {
  switch (message.kind) {
    case "user":
      return { kind: "user", key: key(message), text: message.content };
    case "conductor":
      return {
        kind: "reply",
        key: key(message),
        text: message.content,
        streaming: false,
        stopped: stoppedMetaSchema.safeParse(message.meta).success,
      };
    case "action":
      return { kind: "action", key: key(message), text: message.content };
    case "proposal":
      return decisionEntry(message, proposals, decided);
    case "plan":
      return planEntry(message, plans);
    case "system":
      return { kind: "event", key: key(message), ts: message.ts, text: message.content };
  }
}

export function buildTranscript(chat: ChatState, proposals: Proposals): ChatEntry[] {
  const history = {
    proposals,
    decided: decidedStatuses(chat.messages),
    plans: planHistory(chat.messages),
  };
  const entries = chat.messages
    .filter((message) => startedPlanId(message) === null)
    .map((message) => messageEntry(message, history));
  const drafts = Object.entries(chat.drafts).map(([turnId, text]): ChatEntry => ({
    kind: "reply",
    key: `draft-${turnId}`,
    text,
    streaming: true,
    stopped: false,
  }));
  return [...entries, ...drafts];
}

export function pendingDecisions(entries: readonly ChatEntry[]): number {
  return entries.filter((entry) => entry.kind === "decision" && entry.status === "pending").length;
}

export function isFirstRun(messages: readonly ChatMessage[]): boolean {
  return !messages.some((message) => message.kind === "user");
}

export function isSetupConfirmed(messages: readonly ChatMessage[]): boolean {
  return messages.some(
    (message) => message.kind === "system" && setupMetaSchema.safeParse(message.meta).success,
  );
}
