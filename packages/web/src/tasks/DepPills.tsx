import { depStatusWord } from "./board.js";
import type { DepStatus } from "./board.js";

export function DepPills({ deps }: { deps: readonly DepStatus[] }) {
  return (
    <ul className="dep-pills" aria-label="Waits on">
      {deps.map((dep) => (
        <li key={dep.id} className="dep-pill">
          <code>{dep.id}</code> · {depStatusWord(dep)}
        </li>
      ))}
    </ul>
  );
}
