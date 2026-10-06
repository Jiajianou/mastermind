import type { UpNext } from "./up-next.js";
import { SidePanel } from "./SidePanel.js";

export function UpNextPanel({ upNext, hold }: { upNext: UpNext; hold: string | null }) {
  const { ready, waiting } = upNext;
  return (
    <SidePanel title="Up next">
      {hold !== null && <p className="side-note">{hold}</p>}
      {ready.length === 0 && waiting.length === 0 ? (
        <p className="muted">Nothing left to start.</p>
      ) : (
        <ul className="side-list">
          {ready.map((task) => (
            <li key={task.id}>
              <code>{task.id}</code> <span className="ready-tag">ready</span>
            </li>
          ))}
          {waiting.map(({ task, reason }) => (
            <li key={task.id}>
              <code>{task.id}</code> <span className="muted">{reason}</span>
            </li>
          ))}
        </ul>
      )}
    </SidePanel>
  );
}
