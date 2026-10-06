import { planLabel } from "@mastermind/core/contracts";
import { useId } from "react";
import { Link } from "react-router";
import { useLive } from "../store/hooks.js";
import { runStatus } from "../store/status.js";

const ctrlCNote = "Ctrl+C twice in the terminal stops mastermind and every session it started.";

export function RunStatusLink() {
  const connection = useLive((state) => state.connection);
  const scheduler = useLive((state) => state.scheduler);
  const instance = useLive((state) => state.instance);
  const tooltipId = useId();
  const { word, tone } = runStatus(connection, scheduler);
  const plan = instance === null ? null : planLabel(instance.account.plan);
  const account = instance?.account.email ?? "Signed in to Claude";

  return (
    <div className="run-status">
      <Link to="/settings" className="run-status-link" aria-describedby={tooltipId}>
        <span className={`status-dot status-${tone}`} aria-hidden="true" />
        {plan === null ? word : `${word} · ${plan}`}
      </Link>
      <span role="tooltip" id={tooltipId} className="tooltip">
        <span className="tooltip-account">
          {plan === null ? account : `${account} · Claude ${plan}`}
        </span>
        <span>{ctrlCNote}</span>
      </span>
    </div>
  );
}
