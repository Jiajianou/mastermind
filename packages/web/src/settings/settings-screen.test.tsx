import type { Config } from "@mastermind/core/contracts";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../api/client.js";
import { SettingsScreen } from "../screens/SettingsScreen.js";
import { LiveProvider } from "../store/hooks.js";
import { createStore } from "../store/store.js";
import { config, snapshot, stateWith } from "../testing/fixtures.js";

interface Patch {
  path: string;
  body: unknown;
}

function serveConfig(patches: Patch[], saved: Config): void {
  vi.stubGlobal("fetch", (path: string, init: RequestInit) => {
    if (init.method !== "PATCH" || typeof init.body !== "string")
      return Promise.reject(new TypeError(`no stub for ${init.method ?? "GET"} ${path}`));
    patches.push({ path, body: JSON.parse(init.body) });
    return Promise.resolve(Response.json(saved));
  });
}

function renderSettings() {
  const { instance } = snapshot();
  const store = createStore(stateWith({ instance, config: config("opus") }));
  render(
    <LiveProvider store={store} api={createApiClient("8f3c2a91".repeat(8))}>
      <MemoryRouter>
        <SettingsScreen />
      </MemoryRouter>
    </LiveProvider>,
  );
  return store;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings", () => {
  it("saves only what the owner edited, keeping a change the chat made meanwhile", async () => {
    const user = userEvent.setup();
    const patches: Patch[] = [];
    const store = renderSettings();
    const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save" });
    const workers = screen.getByRole<HTMLSelectElement>("combobox", { name: "Parallel workers" });
    expect(save.disabled).toBe(true);
    expect(workers.selectedOptions[0]?.textContent).toBe("Auto (2 on Max)");

    await user.selectOptions(screen.getByRole("combobox", { name: "Worker model" }), "sonnet");
    await user.click(screen.getByRole("radio", { name: "Allowlist" }));
    await user.type(screen.getByRole("textbox", { name: "Allowed tools" }), "Bash(make *)");
    await user.type(
      screen.getByRole("textbox", { name: "Paths that always wait for your review" }),
      "kernel/vfs/{Enter}{Enter}docs/",
    );
    await user.selectOptions(workers, "3");
    act(() => {
      store.dispatch({ type: "config.updated", config: config("haiku") });
    });

    const edited = {
      ...config("haiku"),
      models: { ...config("haiku").models, worker: "sonnet" },
    };
    serveConfig(patches, edited);
    await user.click(save);

    expect(patches).toEqual([
      {
        path: "/api/config",
        body: {
          models: { worker: "sonnet" },
          maxWorkers: 3,
          workerPermissions: "allowlist",
          workerAllowedTools: ["Bash(make *)"],
          requireReviewFor: ["kernel/vfs/", "docs/"],
        },
      },
    ]);
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("Saved to .mastermind/config.yaml");
    });
    expect(store.getState().config).toEqual(edited);
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Chat model" }).value).toBe(
      "haiku",
    );
    expect(save.disabled).toBe(true);
  });

  it("shows why a save was refused and keeps the edit", async () => {
    const user = userEvent.setup();
    renderSettings();
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        Response.json(
          {
            code: "invalid_input",
            message: "config change: commands.test: expected a string",
            issues: [],
          },
          { status: 400 },
        ),
      ),
    );

    await user.type(screen.getByRole("textbox", { name: "Test command" }), "make test");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't save the settings: config change: commands.test: expected a string",
    );
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Test command" }).value).toBe(
      "make test",
    );
  });
});
