import type { OwnerNotification } from "@mastermind/core/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import { LiveProvider } from "../store/hooks.js";
import { createStore } from "../store/store.js";
import { config, stateWith } from "../testing/fixtures.js";
import { DesktopNotifications } from "./DesktopNotifications.js";

class FakeNotification extends EventTarget {
  static permission: NotificationPermission = "granted";
  static shown: FakeNotification[] = [];
  static requests = 0;
  closed = false;

  static requestPermission(): Promise<NotificationPermission> {
    FakeNotification.requests += 1;
    return Promise.resolve(FakeNotification.permission);
  }

  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    FakeNotification.shown.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

function Location() {
  const { pathname, search } = useLocation();
  return <output aria-label="Location">{`${pathname}${search}`}</output>;
}

function renderNotifications() {
  const store = createStore(stateWith({ config: config("opus") }));
  const view = render(
    <LiveProvider store={store} api={createApiClient("8f3c2a91".repeat(8))}>
      <MemoryRouter>
        <DesktopNotifications />
        <Location />
      </MemoryRouter>
    </LiveProvider>,
  );
  const notify = (notification: OwnerNotification) => {
    act(() => {
      store.dispatch({ type: "notification", notification });
    });
  };
  return { notify, unmount: view.unmount };
}

const blocked: OwnerNotification = {
  id: 7,
  title: "mastermind · demo",
  body: "parser is blocked",
  reason: "blocked",
  taskId: "parser",
};

beforeEach(() => {
  FakeNotification.permission = "granted";
  FakeNotification.shown = [];
  FakeNotification.requests = 0;
  vi.stubGlobal("Notification", FakeNotification);
  vi.spyOn(window, "focus").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("desktop notifications in the browser", () => {
  it.each([
    { reason: "blocked", taskId: "parser", path: "/tasks?task=parser" },
    { reason: "review", taskId: "parser", path: "/review/decide/parser" },
    { reason: "sign_in", taskId: null, path: "/" },
    { reason: "usage_limit", taskId: null, path: "/overview" },
  ] as const)("shows a $reason notification once and opens $path on click", (row) => {
    const { notify } = renderNotifications();
    const notification = { ...blocked, reason: row.reason, taskId: row.taskId };

    notify(notification);
    notify(notification);

    expect(
      FakeNotification.shown.map(({ title, options }) => ({ title, body: options.body })),
    ).toEqual([{ title: "mastermind · demo", body: "parser is blocked" }]);
    const [shown] = FakeNotification.shown;
    act(() => {
      shown?.dispatchEvent(new Event("click"));
    });
    expect(screen.getByRole("status", { name: "Location" }).textContent).toBe(row.path);
    expect(shown?.closed).toBe(true);
  });

  it("asks for permission once, on the first interaction, and shows nothing without it", async () => {
    FakeNotification.permission = "default";
    const first = renderNotifications();

    first.notify(blocked);
    expect(FakeNotification.shown).toEqual([]);
    expect(FakeNotification.requests).toBe(0);

    fireEvent.pointerDown(window);
    fireEvent.keyDown(window, { key: "a" });
    await act(() => Promise.resolve());
    expect(FakeNotification.requests).toBe(1);

    first.unmount();
    renderNotifications();
    fireEvent.pointerDown(window);
    await act(() => Promise.resolve());
    expect(FakeNotification.requests).toBe(1);
  });
});
