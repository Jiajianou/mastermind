import { z } from "zod";
import { ActionError, defineAction, parseInput } from "./actions/index.js";
import type { ActionRegistry, ContractedActions } from "./actions/index.js";
import { postChatMessage, postConductorMessage } from "./chat.js";
import type { Clock } from "./clock.js";
import { ConfigError } from "./config/index.js";
import { errorMessage, jsonValueSchema, proposalRefInputSchema } from "./contracts/index.js";
import type {
  ChatTurnRef,
  JsonValue,
  Proposal,
  ProposalMeta,
  ProposalOutcome,
  ProposalStatus,
} from "./contracts/index.js";
import type { Db } from "./db/index.js";
import type { EventBus } from "./events.js";

export const proposalLifetimeMs = 60 * 60_000;

export interface ActionDescriber {
  action: string;
  describe(input: unknown): string;
}

export interface GateableTool extends ActionDescriber {
  name: string;
}

export interface Offer {
  action: string;
  args: JsonValue;
  question: string;
  confirmLabel: string;
}

export type GateOutcome =
  | { kind: "done"; result: unknown }
  | { kind: "awaiting_confirmation"; proposal: Proposal; question: string };

export interface ProposalGate {
  isGated(toolName: string): boolean;
  run(tool: GateableTool, input: unknown): Promise<GateOutcome>;
  offer(offer: Offer): Proposal;
  confirm(proposalId: number): Promise<Proposal>;
  reject(proposalId: number): Proposal;
  expireStale(): Proposal[];
}

export interface ProposalGateOptions {
  db: Db;
  bus: EventBus;
  actions: ActionRegistry;
  clock: Clock;
  tools: readonly GateableTool[];
  describers?: readonly ActionDescriber[];
  confirmList: () => readonly string[];
  activeTurn: () => ChatTurnRef | null;
  lifetimeMs?: number;
}

type Decision = Exclude<ProposalStatus, "pending">;

function toJsonValue(value: unknown): JsonValue {
  return value === undefined ? null : jsonValueSchema.parse(JSON.parse(JSON.stringify(value)));
}

const taskArgsSchema = z.object({ taskId: z.string() });

function proposalMeta(proposal: Proposal): ProposalMeta {
  const args = taskArgsSchema.safeParse(proposal.args);
  return args.success
    ? { proposalId: proposal.id, taskId: args.data.taskId }
    : { proposalId: proposal.id };
}

const isActionFailure = (error: unknown): error is Error =>
  error instanceof ActionError || error instanceof ConfigError;

function decisionText(what: string, status: Decision, outcome: ProposalOutcome | null): string {
  switch (status) {
    case "confirmed":
      return outcome === null || outcome.ok
        ? `${what}: confirmed by the owner and done.`
        : `${what}: confirmed by the owner, but it failed: ${outcome.message}`;
    case "rejected":
      return `${what}: declined by the owner.`;
    case "expired":
      return `${what}: expired without an answer from the owner.`;
  }
}

// One decision per proposal: a confirm that arrives while the action is still running joins it instead of
// running the action again.
export function createProposalGate(options: ProposalGateOptions): ProposalGate {
  const { db, actions, clock, confirmList, lifetimeMs = proposalLifetimeMs } = options;
  const describers = [...options.tools, ...(options.describers ?? [])];
  const running = new Map<number, Promise<Proposal>>();
  const isGated = (toolName: string): boolean => confirmList().includes(toolName);

  function describe(action: string, args: unknown): string {
    const describer = describers.find((candidate) => candidate.action === action);
    return describer === undefined ? action : describer.describe(args);
  }

  function requireProposal(proposalId: number): Proposal {
    const proposal = db.proposals.get(proposalId);
    if (proposal === null)
      throw ActionError.fromMessage("not_found", `no proposal ${String(proposalId)}`);
    return proposal;
  }

  const isStale = (proposal: Proposal): boolean =>
    clock.now().getTime() - Date.parse(proposal.ts) >= lifetimeMs;

  function settle(
    proposal: Proposal,
    status: Decision,
    outcome: ProposalOutcome | null = null,
  ): Proposal {
    const decided = db.proposals.decide(proposal.id, status, outcome);
    options.bus.emit({ type: "proposal.updated", proposal: decided });
    postChatMessage(options, {
      kind: "system",
      content: decisionText(describe(proposal.action, proposal.args), status, outcome),
      meta: { proposalId: proposal.id, status } satisfies ProposalMeta,
    });
    return decided;
  }

  async function execute(proposal: Proposal): Promise<Proposal> {
    let value: unknown;
    try {
      value = await actions.invoke(proposal.action, proposal.args);
    } catch (error) {
      const message = errorMessage(error);
      const decided = settle(proposal, "confirmed", { ok: false, message });
      if (isActionFailure(error)) return decided;
      throw error;
    }
    return settle(proposal, "confirmed", { ok: true, value: toJsonValue(value) });
  }

  function validate(action: string, input: unknown): unknown {
    const info = actions.list().find((candidate) => candidate.name === action);
    if (info === undefined)
      throw ActionError.fromMessage("not_found", `unknown action "${action}"`);
    return parseInput(info.input, input);
  }

  return {
    isGated,

    async run(tool, input) {
      if (!isGated(tool.name)) {
        return { kind: "done", result: await actions.invoke(tool.action, input) };
      }
      const args = toJsonValue(validate(tool.action, input));
      const question = `${tool.describe(args)}?`;
      const proposal = db.proposals.create({ action: tool.action, args });
      options.bus.emit({ type: "proposal.updated", proposal });
      postConductorMessage(options, {
        kind: "proposal",
        content: question,
        meta: proposalMeta(proposal),
      });
      return { kind: "awaiting_confirmation", proposal, question };
    },

    // Mastermind's own offers are not part of a Conductor turn.
    offer({ action, args, question, confirmLabel }) {
      const proposal = db.proposals.create({ action, args: toJsonValue(validate(action, args)) });
      options.bus.emit({ type: "proposal.updated", proposal });
      postChatMessage(options, {
        kind: "proposal",
        content: question,
        meta: { ...proposalMeta(proposal), confirmLabel } satisfies ProposalMeta,
      });
      return proposal;
    },

    async confirm(proposalId) {
      const inFlight = running.get(proposalId);
      if (inFlight !== undefined) return inFlight;
      const proposal = requireProposal(proposalId);
      if (proposal.status !== "pending") return proposal;
      if (isStale(proposal)) return settle(proposal, "expired");
      const execution = execute(proposal).finally(() => running.delete(proposalId));
      running.set(proposalId, execution);
      return await execution;
    },

    reject(proposalId) {
      const proposal = requireProposal(proposalId);
      if (proposal.status !== "pending" || running.has(proposalId)) return proposal;
      return settle(proposal, isStale(proposal) ? "expired" : "rejected");
    },

    expireStale() {
      return db.proposals
        .listPending()
        .filter((proposal) => !running.has(proposal.id) && isStale(proposal))
        .map((proposal) => settle(proposal, "expired"));
    },
  };
}

export function proposalActions(gate: ProposalGate) {
  const confirmProposal = defineAction({
    name: "confirmProposal",
    description:
      "Confirm a pending proposal: its action runs once and the outcome is posted to the chat. Confirming a decided proposal changes nothing.",
    input: proposalRefInputSchema,
    emits: ["proposal.updated", "chat.message"],
    handler: ({ proposalId }) => gate.confirm(proposalId),
  });
  const rejectProposal = defineAction({
    name: "rejectProposal",
    description:
      "Decline a pending proposal; its action never runs. Rejecting a decided proposal changes nothing.",
    input: proposalRefInputSchema,
    emits: ["proposal.updated", "chat.message"],
    handler: ({ proposalId }) => gate.reject(proposalId),
  });
  return [confirmProposal, rejectProposal] as const satisfies readonly [
    ContractedActions<"confirmProposal">["confirmProposal"],
    ContractedActions<"rejectProposal">["rejectProposal"],
  ];
}
