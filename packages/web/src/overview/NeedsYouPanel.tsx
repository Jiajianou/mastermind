import { Link } from "react-router";
import type { NeedsYouItem } from "./board.js";
import { SidePanel } from "./SidePanel.js";

function itemKey(item: NeedsYouItem): string {
  return item.kind === "decisions" ? item.kind : `${item.kind}-${item.task.id}`;
}

function NeedsYouEntry({ item }: { item: NeedsYouItem }) {
  switch (item.kind) {
    case "review":
      return (
        <Link to={`/review?task=${encodeURIComponent(item.task.id)}`}>
          <code>{item.task.id}</code> is ready for review
        </Link>
      );
    case "blocked":
      return (
        <Link to={`/tasks?task=${encodeURIComponent(item.task.id)}`}>
          <code>{item.task.id}</code> is blocked
        </Link>
      );
    case "decisions":
      return (
        <Link to="/">
          {item.count === 1 ? "1 decision" : `${String(item.count)} decisions`} waiting in the chat
        </Link>
      );
  }
}

export function NeedsYouPanel({ items }: { items: readonly NeedsYouItem[] }) {
  return (
    <SidePanel title="Needs you">
      {items.length === 0 ? (
        <p className="muted">Nothing needs you right now.</p>
      ) : (
        <ul className="side-list needs-you">
          {items.map((item) => (
            <li key={itemKey(item)}>
              <NeedsYouEntry item={item} />
            </li>
          ))}
        </ul>
      )}
    </SidePanel>
  );
}
