import type { Session, Task } from "@mastermind/core/contracts";
import { capitalized } from "@mastermind/core/contracts";
import { contextWindow } from "./activity.js";
import type { SessionActivity } from "./activity.js";
import { Elapsed } from "./Elapsed.js";

const thousands = (tokens: number): string => `${String(Math.round(tokens / 1000))}k`;

function ContextBar({ tokens, model }: { tokens: number | null; model: string | null }) {
  if (tokens === null) return <span className="muted">not known yet</span>;
  const size = contextWindow(model);
  return (
    <span className="context">
      <meter min={0} max={size} value={tokens} aria-label="Context used" />
      <span>
        {thousands(tokens)} of {thousands(size)} tokens
      </span>
    </span>
  );
}

export function SessionFacts({
  session,
  task,
  activity,
}: {
  session: Session;
  task: Task | undefined;
  activity: SessionActivity;
}) {
  return (
    <aside className="session-facts panel" aria-label="Session facts">
      <dl className="facts">
        <dt>Role</dt>
        <dd>{capitalized(session.role)}</dd>
        <dt>Model</dt>
        <dd>
          <code>{session.model ?? "default"}</code>
        </dd>
        <dt>Attempt</dt>
        <dd>{String(session.attempt ?? 1)}</dd>
        <dt>Elapsed</dt>
        <dd>
          <Elapsed session={session} />
        </dd>
        <dt>Commits</dt>
        <dd>{String(activity.commits)}</dd>
        <dt>Files</dt>
        <dd>{String(activity.files.length)}</dd>
        <dt>Context</dt>
        <dd>
          <ContextBar tokens={activity.contextTokens} model={session.model} />
        </dd>
      </dl>
      {task !== undefined && (
        <section className="task-brief" aria-label="Task">
          <h3>Goal</h3>
          <p>{task.goal}</p>
          <h3>Acceptance</h3>
          <pre>
            <code>{task.acceptance}</code>
          </pre>
        </section>
      )}
    </aside>
  );
}
