import type { ProposalStatus } from "@mastermind/core/contracts";
import { Link } from "react-router";
import { taskReviewPath } from "../decide/task-state.js";
import { useApi, useDispatch, useLive } from "../store/hooks.js";
import { useRequest } from "../components/use-request.js";

const outcomeWords: Record<Exclude<ProposalStatus, "pending">, string> = {
  confirmed: "Confirmed",
  rejected: "Declined",
  expired: "Expired without an answer",
};

// Each question is an imperative phrase ("Rebase sched-prio onto main?"), so its verb labels the button.
const confirmLabel = (question: string): string => /^\p{L}+/u.exec(question)?.[0] ?? "Confirm";

export interface DecisionBoxProps {
  proposalId: number;
  question: string;
  status: ProposalStatus;
  taskId: string | null;
}

export function DecisionBox({ proposalId, question, status, taskId }: DecisionBoxProps) {
  const api = useApi();
  const dispatch = useDispatch();
  const { busy, failure, run } = useRequest();
  const taskStatus = useLive((state) =>
    taskId === null ? undefined : state.tasks[taskId]?.status,
  );

  const decide = (decision: "confirmProposal" | "rejectProposal") =>
    run(async () => {
      dispatch({ type: "proposal.updated", proposal: await api.act(decision, { proposalId }) });
    });

  return (
    <section className="decision" aria-label="Decision">
      <p className="decision-question">{question}</p>
      {status === "pending" ? (
        <div className="decision-controls">
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void decide("confirmProposal")}
          >
            {confirmLabel(question)}
          </button>
          <button type="button" disabled={busy} onClick={() => void decide("rejectProposal")}>
            Not now
          </button>
          {taskId !== null && <Link to={taskReviewPath(taskId, taskStatus)}>See changes</Link>}
        </div>
      ) : (
        <p className="muted-line">{outcomeWords[status]}</p>
      )}
      {failure !== null && (
        <p role="alert" className="control-failure">
          Couldn&apos;t answer: {failure}
        </p>
      )}
    </section>
  );
}
