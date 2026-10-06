import type { OwnerBranch } from "@mastermind/core/contracts";
import { useEffect, useState } from "react";
import { errorMessage } from "@mastermind/core/contracts";
import { useRequest } from "../components/use-request.js";
import { useCoalescedLoad } from "../review/use-coalesced-load.js";
import { useApi, useDispatch, useLive } from "../store/hooks.js";
import { branchFacts, rebaseNote } from "./branch.js";
import { SidePanel } from "./SidePanel.js";

function BranchState({ view, live }: { view: OwnerBranch; live: boolean }) {
  const api = useApi();
  const dispatch = useDispatch();
  const { busy, failure, run } = useRequest();
  const { branch, mainBranch } = view;
  if (branch === null) return <p className="muted">Your checkout isn't on a branch.</p>;
  if (view.onMain)
    return (
      <p className="side-note">You're on {mainBranch}. Switch to your own branch to rebase it.</p>
    );
  const note = rebaseNote(view);
  const running = view.rebase?.status === "running";

  const rebase = () =>
    run(async () => {
      const started = await api.act("rebaseOwnerBranch", { branch });
      dispatch({ type: "branch.updated", branch: { ...view, rebase: started } });
    });

  return (
    <>
      <p>
        <code>{branch}</code>
      </p>
      <ul className="side-list branch-facts">
        {branchFacts(view).map((fact) => (
          <li key={fact} className="muted">
            {fact}
          </li>
        ))}
      </ul>
      {note !== null && <p className="branch-note">{note}</p>}
      <div className="branch-actions">
        <button
          type="button"
          className="primary"
          disabled={!live || busy || running}
          onClick={() => void rebase()}
        >
          {busy ? "Rebasing…" : "Rebase"}
        </button>
        {failure !== null && (
          <span role="alert" className="control-failure">
            Couldn't rebase: {failure}
          </span>
        )}
      </div>
    </>
  );
}

// The owner commits and switches branches outside mastermind, so the view is read again whenever they come back.
function useFocusCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const refocused = () => {
      setCount((previous) => previous + 1);
    };
    window.addEventListener("focus", refocused);
    return () => {
      window.removeEventListener("focus", refocused);
    };
  }, []);
  return count;
}

export function OwnerBranchPanel() {
  const api = useApi();
  const dispatch = useDispatch();
  const live = useLive((state) => state.connection === "live");
  const view = useLive((state) => state.ownerBranch);
  const focusCount = useFocusCount();
  const [failure, setFailure] = useState<string | null>(null);

  useCoalescedLoad(live ? `branch:${String(focusCount)}` : null, async () => {
    try {
      dispatch({ type: "branch.updated", branch: await api.read("branch") });
      setFailure(null);
    } catch (error) {
      setFailure(errorMessage(error));
    }
  });

  return (
    <SidePanel title="Your branch">
      {view === null ? (
        <p className="muted">{failure ?? "Reading your branch…"}</p>
      ) : (
        <BranchState view={view} live={live} />
      )}
    </SidePanel>
  );
}
