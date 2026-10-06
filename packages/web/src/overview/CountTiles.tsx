import type { CountTiles as Counts } from "./board.js";

export function CountTiles({ counts }: { counts: Counts }) {
  const tiles = [
    { label: "Remaining", value: counts.remaining },
    { label: "Running", value: counts.running },
    { label: "Done", value: counts.done },
    { label: "Blocked", value: counts.blocked, attention: counts.blocked > 0 },
  ];
  return (
    <div className="count-tiles">
      <ul aria-label="Task counts" className="tiles">
        {tiles.map(({ label, value, attention }) => (
          <li key={label} className={attention === true ? "tile panel attention" : "tile panel"}>
            <span className="tile-value">{String(value)}</span>
            <span className="tile-label">{label}</span>
          </li>
        ))}
      </ul>
      <div className="progress panel">
        <span>
          <strong>{String(counts.done)}</strong> of {String(counts.total)} done
        </span>
        <progress max={Math.max(counts.total, 1)} value={counts.done} aria-label="Tasks done" />
      </div>
    </div>
  );
}
