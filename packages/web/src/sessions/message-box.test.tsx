import type { MessageSessionResult, Session } from "@mastermind/core/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import { SessionsScreen } from "../screens/SessionsScreen.js";
import { LiveProvider } from "../store/hooks.js";
import { createStore } from "../store/store.js";
import { at, session, stateWith, task } from "../testing/fixtures.js";

const posted: { path: string; body: unknown }[] = [];

function serve(result: MessageSessionResult): void {
  vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
    if (/^\/api\/sessions\/\d+\/events/.test(path)) return Promise.resolve(Response.json([]));
    if (path === `/api/sessions/3/message`) {
      posted.push({ path, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      return Promise.resolve(Response.json(result));
    }
    return Promise.reject(new TypeError(`no stub for ${path}`));
  });
}

function renderSessions(selected: Session) {
  const store = createStore(
    stateWith({ tasks: { alpha: task("alpha") }, sessions: { [selected.id]: selected } }),
  );
  render(
    <LiveProvider store={store} api={createApiClient("8f3c2a91".repeat(8))}>
      <MemoryRouter initialEntries={[`/sessions?session=${String(selected.id)}`]}>
        <SessionsScreen />
      </MemoryRouter>
    </LiveProvider>,
  );
}

afterEach(() => {
  cleanup();
  posted.length = 0;
  vi.unstubAllGlobals();
});

describe("session message box", () => {
  it("sends a message to a running session on Enter and says it was sent", async () => {
    const running = session(3);
    serve({ delivery: "live", session: running });
    renderSessions(running);

    await userEvent.type(
      screen.getByRole("textbox", { name: "Message this session" }),
      "Write the tests first{Enter}",
    );

    expect(posted).toEqual([
      { path: "/api/sessions/3/message", body: { text: "Write the tests first" } },
    ]);
    expect((await screen.findByRole("status")).textContent).toBe(
      "Sent. The session reads it at its next step.",
    );
    expect(screen.getByRole("textbox", { name: "Message this session" })).toHaveProperty(
      "value",
      "",
    );
  });

  it("explains that messaging an ended session resumes it, then shows the resumed session", async () => {
    const ended = session(3, { status: "succeeded", endedAt: at(4) });
    serve({ delivery: "resumed", session: session(4, { startedAt: at(5) }) });
    renderSessions(ended);
    const box = screen.getByRole("textbox", { name: "Message this session" });

    expect(box.getAttribute("aria-describedby")).not.toBeNull();
    expect(
      screen.getByText("It has ended, so sending resumes it in the same workspace."),
    ).toBeDefined();
    await userEvent.type(box, "Add a changelog too{Enter}");

    expect(posted).toHaveLength(1);
    const current = await screen.findByRole("link", { current: "page" });
    expect(current.getAttribute("href")).toBe("/sessions?session=4");
    expect(
      screen.queryByText("It has ended, so sending resumes it in the same workspace."),
    ).toBeNull();
  });
});
