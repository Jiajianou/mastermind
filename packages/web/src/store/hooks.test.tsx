import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "../api/client.js";
import { session, stateWith, task } from "../testing/fixtures.js";
import { LiveProvider, useSession, useTask } from "./hooks.js";
import { createStore } from "./store.js";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const renders: string[] = [];

function TaskPane({ taskId }: { taskId: string }) {
  const shown = useTask(taskId);
  renders.push(`task ${taskId}`);
  return <p>{shown?.status}</p>;
}

function SessionPane({ sessionId }: { sessionId: number }) {
  const shown = useSession(sessionId);
  renders.push(`session ${String(sessionId)}`);
  return <p>{shown?.status}</p>;
}

const unmounts: (() => void)[] = [];

afterEach(() => {
  for (const unmount of unmounts.splice(0)) act(unmount);
  renders.length = 0;
});

function renderPanes() {
  const store = createStore(
    stateWith({
      tasks: { alpha: task("alpha"), beta: task("beta") },
      sessions: { 1: session(1), 2: session(2, { taskId: "beta" }) },
    }),
  );
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(
      <LiveProvider store={store} api={createApiClient(null)}>
        <TaskPane taskId="alpha" />
        <TaskPane taskId="beta" />
        <SessionPane sessionId={1} />
        <SessionPane sessionId={2} />
      </LiveProvider>,
    );
  });
  unmounts.push(() => {
    root.unmount();
  });
  renders.length = 0;
  return { store, container };
}

describe("pane hooks", () => {
  it("re-render only the pane whose task or session changed", () => {
    const { store, container } = renderPanes();

    act(() => {
      store.dispatch({
        type: "task.updated",
        taskId: "beta",
        task: task("beta", { status: "running", updatedAt: new Date().toISOString() }),
      });
      store.dispatch({
        type: "session.ended",
        sessionId: 1,
        taskId: "alpha",
        session: session(1, { status: "succeeded" }),
      });
    });

    expect(renders.sort()).toEqual(["session 1", "task beta"]);
    expect(container.textContent).toBe("pendingrunningsucceededrunning");
  });
});
