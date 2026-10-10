export function TurnProgress({ label }: { label: string | null }) {
  return (
    <p className="turn-progress" role="status">
      <span className="typing-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {label === null ? (
        <span className="visually-hidden">mastermind is replying</span>
      ) : (
        <span>{label}…</span>
      )}
    </p>
  );
}
