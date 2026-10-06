import { readFile, stat } from "node:fs/promises";
import { PortUnavailableError } from "@mastermind/core/api";
import { apiErrorSchema, apiResponseSchemas, taskSchema } from "@mastermind/core/contracts";
import type { NewTaskInput } from "@mastermind/core/contracts";
import { readLock, tokenPath } from "@mastermind/core/lock";
import { describe, expect, it } from "vitest";
import { occupyPort, serveTestApi, testInstance, webIndex, webScript } from "./harness.js";
import type { TestApi } from "./harness.js";

type Method = "GET" | "POST" | "PATCH";

interface Call {
  method?: Method;
  body?: unknown;
  headers?: Record<string, string>;
}

function call(test: TestApi, url: string, { method = "GET", body, headers = {} }: Call = {}) {
  const json = body === undefined ? {} : { "content-type": "application/json" };
  return test.api.app.inject({
    method,
    url,
    headers: { authorization: test.authorization, ...json, ...headers },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

const task = (id: string, extra: Partial<NewTaskInput> = {}): NewTaskInput => ({
  id,
  title: `Task ${id}`,
  goal: `Build ${id}.`,
  acceptance: "true",
  touches: [`src/${id}/`],
  ...extra,
});

describe("HTTP API", () => {
  it.each([
    { case: "no token", url: "/api/summary", authorization: () => "" },
    { case: "a wrong token", url: "/api/summary", authorization: () => `Bearer ${"0".repeat(64)}` },
    {
      case: "the token under another scheme",
      url: "/api/summary",
      authorization: (token: string) => `Basic ${token}`,
    },
    { case: "no token on a percent-encoded path", url: "/%61pi/summary", authorization: () => "" },
  ])("answers 401 to an /api request with $case", async ({ url, authorization }) => {
    const test = await serveTestApi();

    const response = await call(test, url, {
      headers: { authorization: authorization(test.api.token) },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe("Bearer");
    expect(apiErrorSchema.parse(response.json()).code).toBe("unauthorized");
    expect((await call(test, url)).statusCode).toBe(200);
  });

  it("refuses a mutation without a token, whichever way its path is spelled", async () => {
    const test = await serveTestApi();

    const responses = await Promise.all(
      ["/api/pause", "/%61pi/pause", "/api/%70ause"].map((url) =>
        call(test, url, { method: "POST", headers: { authorization: "" } }),
      ),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([401, 401, 401]);
    expect(test.db.flags.get().paused).toBe(false);
  });

  it.each<{ headers: Record<string, string>; method: Method; url: string }>([
    { headers: { host: "evil.example:4700" }, method: "GET", url: "/api/summary" },
    { headers: { host: "127.0.0.1.evil.example" }, method: "GET", url: "/api/summary" },
    { headers: { host: "evil.example" }, method: "GET", url: "/" },
    { headers: { origin: "http://evil.example" }, method: "GET", url: "/api/summary" },
    { headers: { origin: "https://localhost:4700" }, method: "GET", url: "/api/summary" },
    { headers: { origin: "null" }, method: "POST", url: "/api/pause" },
  ])("answers 403 to $url with $headers, even with the right token", async (request) => {
    const test = await serveTestApi();

    const response = await call(test, request.url, request);

    expect(response.statusCode).toBe(403);
    expect(apiErrorSchema.parse(response.json()).code).toBe("forbidden");
    expect(test.db.flags.get().paused).toBe(false);
  });

  it.each([
    { host: "localhost:4700", origin: "http://localhost:4700" },
    { host: "127.0.0.1:4700", origin: "http://127.0.0.1:4700" },
    { host: "[::1]:4700", origin: "http://[::1]:4700" },
  ])("accepts requests from the local site $host", async (headers) => {
    const test = await serveTestApi();

    expect((await call(test, "/api/summary", { headers })).statusCode).toBe(200);
  });

  it.each([
    {
      case: "a task id that is not a slug",
      method: "POST" as const,
      url: "/api/tasks",
      body: { tasks: [task("Not A Slug")] },
      path: "tasks[0].id",
    },
    {
      case: "a priority that is not an integer",
      method: "PATCH" as const,
      url: "/api/tasks/alpha",
      body: { priority: "high" },
      path: "priority",
    },
    {
      case: "an unknown field",
      method: "POST" as const,
      url: "/api/tasks/alpha/priority",
      body: { priority: 2, colour: "red" },
      path: "colour",
    },
    {
      case: "a session id that is not a number",
      method: "GET" as const,
      url: "/api/sessions/first/events",
      body: undefined,
      path: "sessionId",
    },
    {
      case: "an unparseable since time",
      method: "GET" as const,
      url: "/api/sessions?since=yesterday",
      body: undefined,
      path: "since",
    },
  ])("answers 400 naming the field for $case", async ({ method, url, body, path }) => {
    const test = await serveTestApi();
    await call(test, "/api/tasks", { method: "POST", body: { tasks: [task("alpha")] } });

    const response = await call(test, url, { method, body });

    expect(response.statusCode).toBe(400);
    const error = apiErrorSchema.parse(response.json());
    expect(error.code).toBe("invalid_input");
    expect(error.issues.map((issue) => issue.path)).toContain(path);
  });

  it("answers 400 to a body that is not JSON", async () => {
    const test = await serveTestApi();

    const response = await test.api.app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { authorization: test.authorization, "content-type": "application/json" },
      payload: "{ tasks: [",
    });

    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).code).toBe("invalid_input");
  });

  it("runs mutations through the action layer and reads the result back", async () => {
    const test = await serveTestApi();

    const created = await call(test, "/api/tasks", {
      method: "POST",
      body: { tasks: [task("alpha"), task("beta"), task("gamma", { deps: ["alpha", "beta"] })] },
    });
    expect(created.statusCode).toBe(200);
    const held = await call(test, "/api/tasks/beta/hold", { method: "POST" });
    expect(taskSchema.parse(held.json()).held).toBe(true);
    await call(test, "/api/tasks/gamma/top", { method: "POST" });
    await call(test, "/api/pause", { method: "POST" });

    const tasks = apiResponseSchemas.tasks.parse((await call(test, "/api/tasks")).json());
    expect(tasks.map(({ id, deps, unblocks }) => ({ id, deps, unblocks }))).toEqual([
      { id: "gamma", deps: ["alpha", "beta"], unblocks: [] },
      { id: "alpha", deps: [], unblocks: ["gamma"] },
      { id: "beta", deps: [], unblocks: ["gamma"] },
    ]);
    const summary = apiResponseSchemas.summary.parse((await call(test, "/api/summary")).json());
    expect(summary).toMatchObject({
      counts: { pending: 3 },
      upNext: ["alpha"],
      paused: true,
      activeSessions: [],
      rebaseQueue: [],
    });
    expect(test.db.tasks.get("gamma")?.priority).toBe(1);
  });

  it.each([
    { url: "/api/tasks/missing/hold", method: "POST" as const, status: 404, code: "not_found" },
    { url: "/api/tasks/missing", method: "GET" as const, status: 404, code: "not_found" },
    { url: "/api/sessions/41/events", method: "GET" as const, status: 404, code: "not_found" },
    { url: "/api/tasks/alpha/retry", method: "POST" as const, status: 409, code: "conflict" },
    { url: "/api/no-such-route", method: "GET" as const, status: 404, code: "not_found" },
  ])("answers $status to $method $url", async ({ url, method, status, code }) => {
    const test = await serveTestApi();
    await call(test, "/api/tasks", { method: "POST", body: { tasks: [task("alpha")] } });

    const response = await call(test, url, { method });

    expect(response.statusCode).toBe(status);
    expect(apiErrorSchema.parse(response.json()).code).toBe(code);
  });

  it("stops a session through the route generated for stopSession", async () => {
    const test = await serveTestApi();
    const session = test.db.sessions.create({ role: "worker" });

    const response = await call(test, `/api/sessions/${String(session.id)}/stop`, {
      method: "POST",
    });

    expect(response.statusCode).toBe(200);
    expect(apiResponseSchemas.sessions.element.parse(response.json()).status).toBe("stopped");
  });

  it("tells the web app which project and account it serves", async () => {
    const test = await serveTestApi();

    const response = await call(test, "/api/instance");

    expect(apiResponseSchemas.instance.parse(response.json())).toEqual(testInstance);
  });

  it("lists sessions and pages through a session's events", async () => {
    const test = await serveTestApi();
    await call(test, "/api/tasks", { method: "POST", body: { tasks: [task("alpha")] } });
    const session = test.db.sessions.create({ role: "worker", taskId: "alpha", attempt: 1 });
    test.db.sessions.create({ role: "conductor" });
    const [first, second] = ["Read README.md", "Edit src/alpha/index.ts"].map((summary) =>
      test.db.events.append({ sessionId: session.id, type: "read", summary, payload: "{}" }),
    );

    const sessions = apiResponseSchemas.sessions.parse(
      (await call(test, "/api/sessions?taskId=alpha")).json(),
    );
    const events = apiResponseSchemas.sessionEvents.parse(
      (
        await call(test, `/api/sessions/${String(session.id)}/events?after=${String(first?.id)}`)
      ).json(),
    );

    expect(sessions.map(({ id }) => id)).toEqual([session.id]);
    expect(events.map(({ id }) => id)).toEqual([second?.id]);
  });

  it("serves the web app and falls back to index.html without a token", async () => {
    const test = await serveTestApi();
    const get = (url: string) => test.api.app.inject({ method: "GET", url });

    const [root, deepLink, script, api] = await Promise.all(
      ["/", "/tasks/alpha", "/assets/app.js", "/api/summary"].map(get),
    );

    expect(root?.body).toBe(webIndex);
    expect(deepLink?.body).toBe(webIndex);
    expect(script?.body).toBe(webScript);
    expect(api?.statusCode).toBe(401);
  });

  it("writes a new token readable only by the owner on every run, and records the port in the lock", async () => {
    const stale = "0".repeat(64);
    const test = await serveTestApi({ staleToken: stale });

    const file = tokenPath(test.stateDir);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file, "utf8")).trim()).toBe(test.api.token);
    expect(test.api.token).toMatch(/^[0-9a-f]{64}$/);
    expect(test.api.token).not.toBe(stale);
    expect(readLock(test.stateDir)?.port).toBe(test.api.port);
    expect(test.api.link).toBe(`http://127.0.0.1:${String(test.api.port)}/#t=${test.api.token}`);
  });

  it("falls back to the next free port when the first is busy, unless the port was asked for", async () => {
    const busy = await occupyPort();

    const test = await serveTestApi({ port: { first: busy, exact: false } });

    expect(test.api.port).toBeGreaterThan(busy);
    expect(
      (await fetch(test.url("/api/summary"), { headers: { authorization: test.authorization } }))
        .status,
    ).toBe(200);
    await expect(serveTestApi({ port: { first: busy, exact: true } })).rejects.toThrow(
      PortUnavailableError,
    );
  });
});
