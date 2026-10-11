import type { StepStatus } from "@mastermind/core/contracts";

const statusWords: Record<StepStatus, string> = {
  running: "in progress",
  done: "done",
  failed: "failed",
};

export function StepRow({
  label,
  status,
  thinking,
  detail,
}: {
  label: string;
  status: StepStatus;
  thinking: boolean;
  detail: string | null;
}) {
  const heading = (
    <>
      <span className={`step-mark step-${status}`} aria-hidden="true">
        {thinking ? "✻" : "●"}
      </span>
      <span className="step-label">{label}</span>
      <span className="visually-hidden"> ({statusWords[status]})</span>
    </>
  );
  if (detail === null) return <p className="step">{heading}</p>;
  return (
    <details className="step">
      <summary>{heading}</summary>
      <pre className="step-detail">{detail}</pre>
    </details>
  );
}
