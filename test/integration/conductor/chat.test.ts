import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { projectPaths } from "@mastermind/core/config";
import { ConductorToolsUnavailableError } from "@mastermind/core/conductor";
import { chatTurnSchema, chatViewSchema, eventLineMetaSchema } from "@mastermind/core/contracts";
import type { BusEvent, EventLineMeta, TaskStatus } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Scenario, Step } from "../../support/fake-claude.js";
import { waitFor } from "../../support/processes.js";
import { conductorHarness, leakedEnv } from "./harness.js";
import type { ConductorHarness } from "./harness.js";

const conductorPrompt = fileURLToPath(new URL("../../../prompts/conductor.md", import.meta.url));

const stoppedSchema = z.object({ stopped: z.boolean() });
const mcpConfigSchema = z.object({
  mcpServers: z.object({
    mastermind: z.object({
      type: z.literal("http"),
      url: z.string(),
      headers: z.object({ Authorization: z.string() }),
    }),
  }),
});

const task = (id: string, deps: string[] = []) => ({
  id,
  title: `Build ${id}`,
  goal: `Make ${id} work.`,
  acceptance: "true",
  touches: [`src/${id}/`],
  deps,
});

function conductorTurn(prompt: string, steps: Step[]): Scenario["turns"][number] {
  return { match: { role: "conductor", prompt }, steps };
}

const reply = (text: string): Step => ({ kind: "text", text });

const fallbackTurn = { match: { role: "conductor" }, steps: [reply("Noted.")] };

async function send(harness: ConductorHarness, text: string, model?: string) {
  return chatTurnSchema.parse(await harness.post("/api/chat", { text, model }));
}

function deltas(events: readonly BusEvent[], turnId: string): string[] {
  return events.flatMap((event) =>
    event.type === "chat.delta" && event.turnId === turnId ? [event.text] : [],
  );
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

async function receivedPrompts(harness: ConductorHarness): Promise<string[]> {
  return (await harness.env.readLog()).flatMap((record) =>
    record.kind === "message" ? [record.text] : [],
  );
}

describe("Conductor chat", () => {
  it("runs a turn that creates tasks through MCP, and stores and streams its reply and action line", async () => {
    const harness = await conductorHarness({
      scenario: {
        turns: [
          conductorTurn("add the parser tasks", [
            reply("Adding them now."),
            {
              kind: "mcp",
              tool: "create_tasks",
              arguments: { tasks: [task("lexer"), task("parser", ["lexer"])] },
            },
            reply("I added lexer and parser; parser waits for lexer."),
          ]),
        ],
      },
    });

    const { turnId, message } = await send(harness, "add the parser tasks");
    const turn = await harness.waitForTurnEnd(turnId);

    const replyText = "Adding them now.\n\nI added lexer and parser; parser waits for lexer.";
    expect(message).toMatchObject({ kind: "user", content: "add the parser tasks", turnId });
    expect(turn.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: "user", content: "add the parser tasks" },
      { kind: "conductor", content: replyText },
      { kind: "action", content: "✓ Added 2 tasks" },
    ]);
    expect(harness.db.tasks.get("parser")).toMatchObject({ status: "pending", deps: ["lexer"] });
    expect(deltas(harness.events, turnId).length).toBeGreaterThan(2);
    expect(deltas(harness.events, turnId).join("")).toBe(replyText);
    expect(
      harness.events.flatMap((event) =>
        event.type === "chat.message" && event.message.turnId === turnId
          ? [event.message.kind]
          : [],
      ),
    ).toEqual(["user", "conductor", "action"]);

    const [invocation] = await harness.env.invocations();
    const sessionId = flagValue(invocation?.argv ?? [], "--session-id");
    expect(sessionId).toBeDefined();
    expect(new Set(turn.map((stored) => stored.conductorSession))).toEqual(new Set([sessionId]));
    expect(chatViewSchema.parse(await harness.get("/api/chat"))).toMatchObject({
      model: "opus",
      replying: false,
      messages: turn,
    });
  });

  it("runs as one detached conductor process with the plan's arguments, a cleaned environment and the bearer MCP config", async () => {
    const harness = await conductorHarness({ scenario: { turns: [fallbackTurn] } });

    const { turnId } = await send(harness, "hello");
    await harness.waitForTurnEnd(turnId);

    const invocations = await harness.env.invocations();
    expect(invocations).toHaveLength(1);
    const [invocation] = invocations;
    if (invocation === undefined) throw new Error("the Conductor never started");
    const { argv } = invocation;
    expect(argv).toEqual(
      expect.arrayContaining([
        "-p",
        "--verbose",
        "--strict-mcp-config",
        "--include-partial-messages",
        "--replay-user-messages",
      ]),
    );
    expect({
      model: flagValue(argv, "--model"),
      input: flagValue(argv, "--input-format"),
      output: flagValue(argv, "--output-format"),
      mcpConfig: flagValue(argv, "--mcp-config"),
      tools: flagValue(argv, "--tools"),
      allowedTools: flagValue(argv, "--allowedTools"),
      systemPrompt: flagValue(argv, "--append-system-prompt-file"),
      settings: flagValue(argv, "--settings"),
    }).toEqual({
      model: "opus",
      input: "stream-json",
      output: "stream-json",
      mcpConfig: harness.mcpConfigPath,
      tools: "Read,Grep,Glob",
      allowedTools: "mcp__mastermind__* Read Grep Glob",
      systemPrompt: conductorPrompt,
      settings: JSON.stringify({ attribution: { commit: "", pr: "", sessionUrl: false } }),
    });
    expect(argv).not.toContain("--bare");
    expect(invocation.cwd).toBe(realpathSync(harness.repo.path));
    expect(invocation.pgid).toBe(invocation.pid);
    for (const name of Object.keys(leakedEnv)) expect(invocation.env).not.toHaveProperty(name);
    expect(harness.registry.tracked()).toContainEqual(
      expect.objectContaining({ kind: "conductor", pid: invocation.pid }),
    );

    expect(statSync(harness.mcpConfigPath).mode & 0o777).toBe(0o600);
    const mcp = mcpConfigSchema.parse(JSON.parse(readFileSync(harness.mcpConfigPath, "utf8")));
    expect(mcp.mcpServers.mastermind.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(mcp.mcpServers.mastermind.headers.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);

    const [prompt] = await receivedPrompts(harness);
    expect(prompt).toMatch(/^<state>\nState at \d\d:\d\d\.\nTasks: none yet\./);
    expect(prompt?.endsWith("\n\nhello")).toBe(true);
  });

  it("stops a turn mid-reply, keeps what was said and answers the next message in a new turn", async () => {
    const story = Array.from({ length: 200 }, (_, index) => `word${String(index)}`).join(" ");
    const harness = await conductorHarness({
      scenario: {
        turns: [
          conductorTurn("tell me a long story", [{ kind: "text", text: story, streamMs: 50 }]),
          fallbackTurn,
        ],
      },
    });

    const { turnId } = await send(harness, "tell me a long story");
    await waitFor(() => deltas(harness.events, turnId).length >= 3, 15_000);
    expect(stoppedSchema.parse(await harness.post("/api/chat/stop"))).toEqual({ stopped: true });
    const next = await send(harness, "are you there?");
    const turn = await harness.waitForTurnEnd(turnId);

    const conductor = turn.find((stored) => stored.kind === "conductor");
    expect(conductor?.meta).toEqual({ stopped: true });
    expect(conductor?.content.length).toBeGreaterThan(0);
    expect(story.startsWith(conductor?.content ?? "")).toBe(true);
    expect(conductor?.content).not.toBe(story);
    expect(turn.map((stored) => stored.kind)).toEqual(["user", "conductor"]);

    expect(next.turnId).not.toBe(turnId);
    const answered = await harness.waitForTurnEnd(next.turnId);
    expect(answered.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: "user", content: "are you there?" },
      { kind: "conductor", content: "Noted." },
    ]);
    expect(stoppedSchema.parse(await harness.post("/api/chat/stop"))).toEqual({ stopped: false });
    expect(await harness.env.invocations()).toHaveLength(1);
  });

  it("starts a new turn for a message sent while a stopped turn is ending", async () => {
    const harness = await conductorHarness({ scenario: { turns: [fallbackTurn] } });

    const stopped = await send(harness, "never mind this");
    expect(stoppedSchema.parse(await harness.post("/api/chat/stop"))).toEqual({ stopped: true });
    const next = await send(harness, "do this instead");
    const answered = await harness.waitForTurnEnd(next.turnId);

    expect(next.turnId).not.toBe(stopped.turnId);
    expect(harness.messages(stopped.turnId).map((message) => message.content)).not.toContain(
      "do this instead",
    );
    expect(answered.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: "user", content: "do this instead" },
      { kind: "conductor", content: "Noted." },
    ]);
    const prompt = (await receivedPrompts(harness)).at(-1);
    expect(prompt?.startsWith("<state>")).toBe(true);
    expect(prompt?.endsWith("\n\ndo this instead")).toBe(true);
  });

  it("adds a message sent mid-turn to the running turn", async () => {
    const harness = await conductorHarness({
      scenario: {
        turns: [
          conductorTurn("plan the release", [
            reply("Looking at the release now."),
            {
              kind: "awaitMessage",
              branches: [{ when: "skip the docs", steps: [reply("OK, leaving the docs out.")] }],
            },
          ]),
        ],
      },
    });

    const first = await send(harness, "plan the release");
    await waitFor(
      () => deltas(harness.events, first.turnId).join("") === "Looking at the release now.",
      15_000,
    );
    const second = await send(harness, "skip the docs");
    const turn = await harness.waitForTurnEnd(first.turnId);

    expect(second.turnId).toBe(first.turnId);
    expect(turn.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: "user", content: "plan the release" },
      { kind: "user", content: "skip the docs" },
      { kind: "conductor", content: "Looking at the release now.\n\nOK, leaving the docs out." },
    ]);
    expect((await receivedPrompts(harness)).at(-1)).toBe("skip the docs");
  });

  it("fails the turn and stops the process when mastermind's tools are unreachable", async () => {
    const harness = await conductorHarness({ scenario: { turns: [fallbackTurn] } });
    const config = mcpConfigSchema.parse(JSON.parse(readFileSync(harness.mcpConfigPath, "utf8")));
    config.mcpServers.mastermind.headers.Authorization = "Bearer wrong-token";
    writeFileSync(harness.mcpConfigPath, JSON.stringify(config));

    const { turnId } = await send(harness, "hello");
    const turn = await harness.waitForTurnEnd(turnId);

    expect(turn.map((stored) => stored.kind)).toEqual(["user", "system"]);
    expect(turn[1]?.content).toMatch(/^Mastermind couldn't reply: /);
    expect(harness.errors.splice(0)).toEqual([expect.any(ConductorToolsUnavailableError)]);
    const ended = await waitFor(
      () => harness.db.sessions.list().find((session) => session.status !== "running"),
      15_000,
    );
    expect(ended.status).toBe("stopped");
    expect(harness.env.livePids()).toEqual([]);
  });

  it("reuses one claude session across turns, resumes it after the idle stop and switches the model", async () => {
    const harness = await conductorHarness({ scenario: { turns: [fallbackTurn] }, idleMs: 1_500 });

    const first = await send(harness, "first");
    await harness.waitForTurnEnd(first.turnId);
    const second = await send(harness, "second");
    await harness.waitForTurnEnd(second.turnId);

    const [invocation] = await harness.env.invocations();
    const sessionId = flagValue(invocation?.argv ?? [], "--session-id");
    expect(await harness.env.invocations()).toHaveLength(1);
    expect(second.message.conductorSession).toBe(sessionId);
    expect(first.turnId).not.toBe(second.turnId);

    const idle = await waitFor(
      () => harness.db.sessions.list().find((session) => session.status !== "running"),
      15_000,
    );
    expect(idle).toMatchObject({
      role: "conductor",
      status: "stopped",
      claudeSessionId: sessionId,
    });
    expect(harness.env.livePids()).toEqual([]);

    const third = await send(harness, "third", "sonnet");
    const turn = await harness.waitForTurnEnd(third.turnId);

    const resumed = (await harness.env.invocations())[1];
    expect(flagValue(resumed?.argv ?? [], "--resume")).toBe(sessionId);
    expect(resumed?.argv).not.toContain("--session-id");
    expect(flagValue(resumed?.argv ?? [], "--model")).toBe("sonnet");
    expect(turn.map((stored) => stored.conductorSession)).toEqual([sessionId, sessionId]);
    const conversation = harness.db.conductorSessions.current();
    expect(conversation).toMatchObject({ id: sessionId, endedAt: null });
    expect(conversation?.tokens).toBeGreaterThan(0);
    expect(harness.config().models.conductor).toBe("sonnet");
    expect(readFileSync(projectPaths(harness.repo.path).localConfig, "utf8")).toMatch(
      /conductor: sonnet/,
    );
    expect(chatViewSchema.parse(await harness.get("/api/chat")).model).toBe("sonnet");
  });

  it("posts event lines only for review, blocked, rebased, sign-in and usage limit, and feeds them to the next turn", async () => {
    const harness = await conductorHarness({ scenario: { turns: [fallbackTurn] } });
    const { db, bus } = harness;
    const moveTask = (taskId: string, status: TaskStatus) => {
      const moved = db.tasks.update(taskId, { status });
      bus.emit({ type: "task.updated", taskId, task: moved });
    };

    await harness.post("/api/tasks", { tasks: [task("lexer"), task("parser"), task("docs")] });
    await harness.post("/api/tasks/docs/hold");
    for (const status of ["running", "checking", "review"] as const) moveTask("lexer", status);
    for (const status of ["running", "blocked"] as const) moveTask("parser", status);
    for (const status of ["running", "checking", "rebasing", "done"] as const)
      moveTask("docs", status);
    moveTask("docs", "done");
    bus.emit({ type: "auth.updated", authRequired: true });
    bus.emit({ type: "auth.updated", authRequired: true });
    bus.emit({ type: "auth.updated", authRequired: false });
    await harness.post("/api/pause");
    const resumeAt = harness.scheduler.reportUsageLimit().toISOString();
    await harness.post("/api/resume");

    const lines = harness.messages().filter((message) => message.kind === "system");
    const expected: EventLineMeta[] = [
      { event: "review", taskId: "lexer" },
      { event: "blocked", taskId: "parser" },
      { event: "rebased", taskId: "docs" },
      { event: "sign_in" },
      { event: "usage_limit", resumeAt },
    ];
    expect(lines.map((line) => eventLineMetaSchema.parse(line.meta))).toEqual(expected);
    expect(lines.slice(0, 4).map((line) => line.content)).toEqual([
      "lexer is ready for review",
      "parser is blocked",
      "docs was rebased onto main",
      "Sign-in needed: finish it in the terminal running mastermind",
    ]);
    expect(lines[4]?.content).toMatch(/^Usage limit reached; work resumes at \d\d:\d\d$/);

    const { turnId } = await send(harness, "what happened?");
    await harness.waitForTurnEnd(turnId);
    const [prompt] = await receivedPrompts(harness);
    expect(prompt).toContain("<updates>");
    for (const line of lines) expect(prompt).toContain(line.content);
  });
});
