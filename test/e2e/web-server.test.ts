import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { projectPaths } from "@mastermind/core/config";
import { streamMessageSchema, streamPath, streamProtocols } from "@mastermind/core/contracts";
import type { StreamMessage } from "@mastermind/core/contracts";
import { readLock } from "@mastermind/core/lock";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { onCleanup } from "../support/cleanup.js";
import { spawnBuiltCli } from "../support/cli.js";
import { isolatedEnv } from "../support/isolated-env.js";
import { waitFor } from "../support/processes.js";
import { createTempRepo } from "../support/temp-repo.js";

const webBuild = new URL("../../packages/web/dist/index.html", import.meta.url);
const printedLink = /Web app → (http:\/\/127\.0\.0\.1:(\d+)\/#t=([0-9a-f]{64}))/;

describe("web app server, through the built binary", () => {
  it("prints the link, serves the bundled web app and API, and tells the stream it is stopping when killed", async () => {
    const repo = await createTempRepo({ files: { "README.md": "# Demo\n" } });
    await repo.git("switch", "--quiet", "--create", "dev");
    const env = await isolatedEnv();
    const mastermind = spawnBuiltCli([repo.path], env.env);
    mastermind.child.stdin.end();
    const exited = once(mastermind.child, "exit");

    const [, link, port, token] = await waitFor(
      () => printedLink.exec(mastermind.output.stdout),
      20_000,
    );
    const origin = `http://127.0.0.1:${String(port)}`;
    expect(link).toBe(`${origin}/#t=${String(token)}`);
    expect(readLock(projectPaths(repo.path).stateDir)?.port).toBe(Number(port));
    expect(await (await fetch(`${origin}/`)).text()).toBe(await readFile(webBuild, "utf8"));
    const summary = await fetch(`${origin}/api/summary`, {
      headers: { authorization: `Bearer ${String(token)}` },
    });
    expect(summary.status).toBe(200);

    const socket = new WebSocket(
      `ws://127.0.0.1:${String(port)}${streamPath}`,
      streamProtocols(String(token)),
    );
    onCleanup(() => {
      socket.terminate();
    });
    const messages: StreamMessage[] = [];
    socket.on("message", (data: Buffer) => {
      messages.push(streamMessageSchema.parse(JSON.parse(data.toString("utf8"))));
    });
    const closeCode = once(socket, "close").then(([code]: unknown[]) => code);
    await once(socket, "open");

    mastermind.child.kill("SIGTERM");

    expect(await closeCode).toBe(1001);
    expect(messages).toEqual([{ type: "service.stopping" }]);
    expect(await exited).toEqual([143, null]);
  });
});
