import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { apiErrorSchema, apiResponseSchemas, taskSchema } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { serveTestApi } from "../api/harness.js";
import type { TestApi } from "../api/harness.js";
import { callTool, connect, text } from "../api/mcp-client.js";

const buildLog = Array.from({ length: 150 }, (_, index) => `line ${String(index + 1)}`);

async function seedChecks(test: TestApi) {
  test.db.tasks.create({
    id: "alpha",
    title: "Alpha",
    goal: "Build alpha.",
    acceptance: "true",
    touches: ["src/"],
    status: "review",
  });
  const logDir = join(test.stateDir, "logs", "checks");
  await mkdir(logDir, { recursive: true });
  const seed = async (kind: "build" | "acceptance", passed: boolean, lines: string[]) => {
    const logPath = join(logDir, `alpha-${kind}.log`);
    await writeFile(logPath, `${lines.join("\n")}\n`);
    const check = test.db.checks.create({ taskId: "alpha", round: 1, kind, logPath });
    return test.db.checks.finish(check.id, {
      status: passed ? "passed" : "failed",
      summary: `${kind} summary`,
      durationMs: 12,
    });
  };
  return {
    build: await seed("build", false, buildLog),
    acceptance: await seed("acceptance", true, ["accepted"]),
  };
}

function get(test: TestApi, url: string) {
  return test.api.app.inject({ url, headers: { authorization: test.authorization } });
}

describe("check routes and tools", () => {
  it("lists a task's checks and serves a check's log", async () => {
    const test = await serveTestApi();
    const { build, acceptance } = await seedChecks(test);

    const checks = apiResponseSchemas.checks.parse(
      (await get(test, "/api/tasks/alpha/checks")).json(),
    );
    const log = apiResponseSchemas.checkLog.parse(
      (await get(test, `/api/checks/${String(build.id)}/log`)).json(),
    );
    const missing = await get(test, "/api/checks/999/log");

    expect(checks).toEqual([build, acceptance]);
    expect(log).toEqual({ check: build, text: buildLog.join("\n"), truncated: false });
    expect(missing.statusCode).toBe(404);
    expect(apiErrorSchema.parse(missing.json()).message).toBe("no check 999");
  });

  it("gives the Conductor the tail of the latest failed check's log, or of the check it names", async () => {
    const test = await serveTestApi();
    const { build, acceptance } = await seedChecks(test);
    const client = await connect(test);

    const latestFailed = apiResponseSchemas.checkLog.parse(
      JSON.parse(text(await callTool(client, "get_check_log", { taskId: "alpha", lines: 3 }))),
    );
    const named = apiResponseSchemas.checkLog.parse(
      JSON.parse(
        text(await callTool(client, "get_check_log", { taskId: "alpha", checkId: acceptance.id })),
      ),
    );

    expect(latestFailed).toEqual({
      check: build,
      text: "line 148\nline 149\nline 150",
      truncated: true,
    });
    expect(named).toEqual({ check: acceptance, text: "accepted", truncated: false });
  });

  it("re-runs a task's checks through its route", async () => {
    const test = await serveTestApi();
    await seedChecks(test);

    const response = await test.api.app.inject({
      method: "POST",
      url: "/api/tasks/alpha/checks/rerun",
      headers: { authorization: test.authorization },
    });

    expect(response.statusCode).toBe(200);
    expect(taskSchema.parse(response.json())).toMatchObject({ id: "alpha", status: "checking" });
  });
});
