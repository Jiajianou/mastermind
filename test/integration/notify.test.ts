import { once } from "node:events";
import { delimiter } from "node:path";
import { createFixerLauncher } from "@mastermind/core/checks";
import { postEventLines } from "@mastermind/core/conductor";
import {
  streamMessageSchema,
  streamPath,
  streamProtocols,
  webStreamProtocols,
} from "@mastermind/core/contracts";
import type { StreamMessage } from "@mastermind/core/contracts";
import { systemClock } from "@mastermind/core/db";
import { createNativeNotifier, NotificationError, notifyOwner } from "@mastermind/core/notify";
import type { DesktopNotification } from "@mastermind/core/notify";
import { createProcessRegistry } from "@mastermind/core/procs";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { makeTempDir, onCleanup } from "../support/cleanup.js";
import { installFakeNotifier } from "../support/fake-notifier.js";
import { waitFor } from "../support/processes.js";
import { serveTestApi } from "./api/harness.js";
import type { TestApi } from "./api/harness.js";

interface Notified {
  test: TestApi;
  native: DesktopNotification[];
  blockTask: (taskId: string) => Promise<void>;
}

async function serveWithNotifications(): Promise<Notified> {
  const test = await serveTestApi();
  const { db, bus } = test;
  const native: DesktopNotification[] = [];
  const errors: unknown[] = [];
  onCleanup(() => {
    if (errors.length > 0) throw new AggregateError(errors, "notifications reported errors");
  });
  const stopLines = postEventLines({ db, bus, mainBranch: () => "main" });
  const stopNotifications = notifyOwner({
    bus,
    project: "demo",
    enabled: () => true,
    webClientConnected: () => test.api.webClientConnected(),
    native: {
      notify(notification) {
        native.push(notification);
        return Promise.resolve();
      },
    },
    onError: (error) => errors.push(error),
  });
  onCleanup(() => {
    stopNotifications();
    stopLines();
  });
  const launcher = createFixerLauncher({
    db,
    bus,
    clock: systemClock,
    maxAttempts: () => 3,
    fixers: { startFixer: () => Promise.reject(new Error("no fixer in this test")) },
    signedIn: () => Promise.resolve(true),
    onError: (error) => errors.push(error),
  });

  return {
    test,
    native,
    blockTask: async (taskId) => {
      const response = await fetch(test.url("/api/tasks"), {
        method: "POST",
        headers: { authorization: test.authorization, "content-type": "application/json" },
        body: JSON.stringify({
          tasks: [{ id: taskId, title: taskId, goal: "Parse.", acceptance: "true", touches: [] }],
        }),
      });
      expect(response.status).toBe(200);
      db.tasks.update(taskId, { status: "checking", attempts: 3 });
      launcher.block(taskId, "checking", 3, "the test check failed");
    },
  };
}

async function connect(test: TestApi, protocols: string[]): Promise<StreamMessage[]> {
  const socket = new WebSocket(test.url(streamPath).replace("http:", "ws:"), protocols);
  onCleanup(() => {
    socket.terminate();
  });
  const messages: StreamMessage[] = [];
  socket.on("message", (data: Buffer) => {
    messages.push(streamMessageSchema.parse(JSON.parse(data.toString("utf8"))));
  });
  await once(socket, "open");
  return messages;
}

const blockedUpdate = (taskId: string) => (message: StreamMessage) =>
  message.type === "task.updated" && message.taskId === taskId && message.task.status === "blocked";

describe("owner notifications", () => {
  it("shows a blocked task as one native notification when no web app is connected", async () => {
    const { test, native, blockTask } = await serveWithNotifications();
    const cliClient = await connect(test, streamProtocols(test.api.token));

    await blockTask("parser");

    await waitFor(() => cliClient.some(blockedUpdate("parser")));
    expect(native).toEqual([{ title: "mastermind · demo", body: "parser is blocked" }]);
    expect(cliClient.filter((message) => message.type === "notification")).toEqual([]);
  });

  it("sends the notification to the connected web app instead of the OS", async () => {
    const { test, native, blockTask } = await serveWithNotifications();
    const webApp = await connect(test, webStreamProtocols(test.api.token));
    await waitFor(() => test.api.webClientConnected());

    await blockTask("parser");

    const notification = await waitFor(() =>
      webApp.find((message) => message.type === "notification"),
    );
    expect(notification).toMatchObject({
      notification: {
        title: "mastermind · demo",
        body: "parser is blocked",
        reason: "blocked",
        taskId: "parser",
      },
    });
    expect(native).toEqual([]);
  });
});

describe("the native notifier", () => {
  const notification = { title: "mastermind · demo", body: 'parser is "blocked"' };

  async function nativeNotifier(platform: NodeJS.Platform, failWith?: string) {
    const binDir = await makeTempDir("notifier");
    const fake = await installFakeNotifier(binDir, failWith === undefined ? {} : { failWith });
    const registry = createProcessRegistry();
    onCleanup(() => {
      registry.killAllSync();
    });
    const env = { PATH: [binDir, "/usr/bin", "/bin"].join(delimiter) };
    return { fake, notifier: createNativeNotifier({ registry, env, platform }) };
  }

  it.each([
    {
      platform: "darwin",
      command: "osascript",
      args: [
        "-e",
        "on run argv",
        "-e",
        "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e",
        "end run",
        notification.title,
        notification.body,
      ],
    },
    {
      platform: "linux",
      command: "notify-send",
      args: ["--app-name=mastermind", notification.title, notification.body],
    },
  ] as const)("uses $command on $platform, passing the text as arguments", async (row) => {
    const { fake, notifier } = await nativeNotifier(row.platform);

    await notifier.notify(notification);

    expect(await fake.calls()).toEqual([{ command: row.command, args: row.args }]);
  });

  it("reports a notifier that fails, with its message", async () => {
    const { notifier } = await nativeNotifier("linux", "no notification daemon");

    const failure = notifier.notify(notification);

    await expect(failure).rejects.toBeInstanceOf(NotificationError);
    await expect(failure).rejects.toThrow(
      "notify-send could not show a notification: no notification daemon",
    );
  });
});
