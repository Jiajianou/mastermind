import type { Board, BoardCard } from "./board.js";
import { TaskCard } from "./TaskCard.js";

function BoardColumn({
  title,
  cards,
  selectedId,
}: {
  title: string;
  cards: readonly BoardCard[];
  selectedId: string | null;
}) {
  return (
    <section className="board-column" aria-label={title}>
      <h2 className="board-column-title">
        {title} <span className="muted">{cards.length}</span>
      </h2>
      {cards.length === 0 ? (
        <p className="muted">None</p>
      ) : (
        <ol className="task-cards">
          {cards.map((card) => (
            <TaskCard key={card.task.id} card={card} selected={card.task.id === selectedId} />
          ))}
        </ol>
      )}
    </section>
  );
}

export function TaskBoard({ board, selectedId }: { board: Board; selectedId: string | null }) {
  return (
    <div className="task-board">
      <BoardColumn title="Remaining" cards={board.remaining} selectedId={selectedId} />
      <BoardColumn title="Running" cards={board.running} selectedId={selectedId} />
      <div className="board-stack">
        <BoardColumn title="Rebasing" cards={board.rebasing} selectedId={selectedId} />
        <BoardColumn title="Blocked" cards={board.blocked} selectedId={selectedId} />
      </div>
      <BoardColumn title="Done" cards={board.done} selectedId={selectedId} />
    </div>
  );
}
