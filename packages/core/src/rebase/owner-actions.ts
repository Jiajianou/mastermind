import { defineAction } from "../actions/index.js";
import type { ContractedActions } from "../actions/index.js";
import { plural, rebaseOwnerBranchInputSchema } from "../contracts/index.js";
import type { Db } from "../db/index.js";
import type { EventBus } from "../events.js";
import type { ProposalGate } from "../proposals.js";
import type { OwnerRebaser } from "./owner-rebase.js";

export const rebaseOwnerBranchActionName = "rebaseOwnerBranch";

export function rebaseOwnerBranchAction(rebaser: Pick<OwnerRebaser, "rebase">) {
  return defineAction({
    name: rebaseOwnerBranchActionName,
    description:
      "Rebase the owner's own branch, the one checked out in their checkout, onto main and fast-forward main to it. Their commits keep their messages and authors and are not squashed; conflicts are resolved by a fixer inside the owner's commits. The checkout must be clean. It runs in the background and returns at once; the outcome is posted to the chat. If branch is given, it must be the branch checked out.",
    input: rebaseOwnerBranchInputSchema,
    emits: ["branch.updated"],
    handler: (input) => rebaser.rebase(input),
  }) satisfies ContractedActions<"rebaseOwnerBranch">["rebaseOwnerBranch"];
}

export interface OwnerRebaseOffersOptions {
  db: Db;
  bus: EventBus;
  gate: Pick<ProposalGate, "offer">;
  rebaser: Pick<OwnerRebaser, "busy" | "branch">;
  onError: (error: unknown) => void;
}

// Keeping the owner's branch current is only ever offered; it runs once the owner confirms (decision 14).
export function offerOwnerRebase({ db, bus, gate, rebaser, onError }: OwnerRebaseOffersOptions) {
  async function offer(): Promise<void> {
    const view = await rebaser.branch();
    if (view.branch === null || view.onMain || view.behind === 0 || rebaser.busy()) return;
    const pending = db.proposals
      .listPending()
      .some((proposal) => proposal.action === rebaseOwnerBranchActionName);
    if (pending) return;
    const commits = plural(view.behind, "commit");
    gate.offer({
      action: rebaseOwnerBranchActionName,
      args: { branch: view.branch },
      question: `${view.mainBranch} moved ${commits}; rebase ${view.branch} onto it?`,
      confirmLabel: "Rebase",
    });
  }

  return bus.subscribe((event) => {
    if (event.type === "main.moved" && !rebaser.busy()) offer().catch(onError);
  });
}
