import { useMemo } from "react";
import { buildTranscript, pendingDecisions } from "../chat/entries.js";
import { countTiles, needsYou, rebaseQueue } from "../overview/board.js";
import { CountTiles } from "../overview/CountTiles.js";
import { NeedsYouPanel } from "../overview/NeedsYouPanel.js";
import { OwnerBranchPanel } from "../overview/OwnerBranchPanel.js";
import { RebaseQueue } from "../overview/RebaseQueue.js";
import { SessionCard } from "../overview/SessionCard.js";
import { schedulerHold, upNext } from "../overview/up-next.js";
import { UpNextPanel } from "../overview/UpNextPanel.js";
import { activeSessions } from "../sessions/session-list.js";
import { useLive } from "../store/hooks.js";

export function OverviewScreen() {
  const tasksById = useLive((state) => state.tasks);
  const sessionsById = useLive((state) => state.sessions);
  const scheduler = useLive((state) => state.scheduler);
  const chat = useLive((state) => state.chat);
  const proposals = useLive((state) => state.proposals);

  const tasks = useMemo(() => Object.values(tasksById), [tasksById]);
  const sessions = useMemo(() => activeSessions(Object.values(sessionsById)), [sessionsById]);
  const decisions = useMemo(
    () => pendingDecisions(buildTranscript(chat, proposals)),
    [chat, proposals],
  );

  return (
    <section className="overview" aria-label="Overview">
      <h1 className="visually-hidden">Overview</h1>
      <CountTiles counts={countTiles(tasks)} />
      <div className="overview-columns">
        <section className="session-cards" aria-label="Active sessions">
          <h2 className="section-title">Active sessions</h2>
          {sessions.length === 0 ? (
            <p className="muted">No sessions running.</p>
          ) : (
            sessions.map((session) => <SessionCard key={session.id} session={session} />)
          )}
        </section>
        <aside className="overview-side">
          <OwnerBranchPanel />
          <RebaseQueue tasks={rebaseQueue(tasks)} />
          <UpNextPanel upNext={upNext(tasks)} hold={schedulerHold(scheduler)} />
          <NeedsYouPanel items={needsYou(tasks, decisions)} />
        </aside>
      </div>
    </section>
  );
}
