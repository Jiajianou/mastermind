import {
  awaitingConfirmationSchema,
  mcpPath,
  proposalSchema,
  taskViewSchema,
} from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { serveTestApi } from "./harness.js";
import { callTool, connect, text } from "./mcp-client.js";

const task = (id: string, deps: string[] = []) => ({
  id,
  title: `Task ${id}`,
  goal: `Build ${id}.`,
  acceptance: "true",
  touches: [`src/${id}/`],
  deps,
});

describe("MCP server", () => {
  it("lists the Conductor tools, each with a description and an input schema", async () => {
    const test = await serveTestApi();
    const client = await connect(test);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "get_summary",
        "list_tasks",
        "get_task",
        "list_sessions",
        "get_session_events",
        "get_changes",
        "create_tasks",
        "update_task",
        "set_priority",
        "hold",
        "release",
        "retry",
        "pause_all",
        "resume_all",
        "stop_session",
        "propose_plan",
        "set_config",
      ].sort(),
    );
    const createTasks = tools.find((tool) => tool.name === "create_tasks");
    expect(createTasks?.inputSchema.properties).toHaveProperty("tasks");
    expect(tools.find((tool) => tool.name === "set_config")?.description).toContain(
      "awaiting_confirmation",
    );
    expect(createTasks?.description).not.toContain("awaiting_confirmation");
  });

  it("runs an ungated tool at once and returns its result", async () => {
    const test = await serveTestApi();
    const client = await connect(test);

    const created = await callTool(client, "create_tasks", {
      tasks: [task("a"), task("b", ["a"])],
    });
    const read = await callTool(client, "get_task", { taskId: "a" });

    expect(created.isError).toBeFalsy();
    expect(test.db.tasks.list().map(({ id }) => id)).toEqual(["a", "b"]);
    expect(taskViewSchema.parse(JSON.parse(text(read)))).toMatchObject({
      id: "a",
      unblocks: ["b"],
    });
  });

  it("reports a dependency cycle in create_tasks as a tool error and stores nothing", async () => {
    const test = await serveTestApi();
    const client = await connect(test);

    const result = await callTool(client, "create_tasks", {
      tasks: [task("a", ["b"]), task("b", ["a"])],
    });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("dependency cycle: a → b → a");
    expect(test.db.tasks.list()).toEqual([]);
  });

  it("reports invalid arguments as a tool error that names the field", async () => {
    const test = await serveTestApi();
    const client = await connect(test);

    const result = await callTool(client, "hold", { taskId: "Not A Slug" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("taskId");
  });

  it("answers set_config with awaiting_confirmation, and the owner's confirm over HTTP applies it", async () => {
    const test = await serveTestApi();
    const client = await connect(test);

    const result = await callTool(client, "set_config", { maxAttempts: 5 });
    const awaiting = awaitingConfirmationSchema.parse(JSON.parse(text(result)));
    const pending = test.db.proposals.get(awaiting.proposalId);
    const confirm = await test.api.app.inject({
      method: "POST",
      url: `/api/proposals/${String(awaiting.proposalId)}/confirm`,
      headers: { authorization: test.authorization },
    });

    expect(result.isError).toBeFalsy();
    expect(pending).toMatchObject({ status: "pending", action: "setConfig" });
    expect(confirm.statusCode).toBe(200);
    expect(proposalSchema.parse(confirm.json())).toMatchObject({
      status: "confirmed",
      result: { ok: true, value: { maxAttempts: 5 } },
    });
    expect(test.db.chat.list().map(({ kind }) => kind)).toEqual(["proposal", "system"]);
  });

  it("shows a proposed plan as a numbered list in the chat without creating tasks", async () => {
    const test = await serveTestApi();
    const client = await connect(test);

    const result = await callTool(client, "propose_plan", {
      tasks: [task("a"), task("b"), { ...task("c", ["a", "b"]), note: "after the first two" }],
    });

    expect(result.isError).toBeFalsy();
    expect(test.db.tasks.list()).toEqual([]);
    expect(test.db.chat.list()).toMatchObject([
      {
        kind: "plan",
        content: "1. a: Task a\n2. b: Task b\n3. c: after the first two",
        meta: { notes: { c: "after the first two" } },
      },
    ]);
  });

  it("refuses a client without the token, and answers GET with 405", async () => {
    const test = await serveTestApi();

    await expect(connect(test, "Bearer wrong")).rejects.toThrow();
    const get = await test.api.app.inject({
      method: "GET",
      url: mcpPath,
      headers: { authorization: test.authorization },
    });

    expect(get.statusCode).toBe(405);
  });
});
