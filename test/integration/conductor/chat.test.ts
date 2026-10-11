import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { projectPaths } from "@mastermind/core/config";
import { ConductorToolsUnavailableError } from "@mastermind/core/conductor";
import {
  chatTurnSchema,
  chatViewSchema,
  eventLineMetaSchema,
  stepMetaSchema,
} from "@mastermind/core/contracts";
import type { BusEvent, ChatMessage, EventLineMeta, TaskStatus } from "@mastermind/core/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Scenario, Step } from "../../support/fake-claude.js";
import { waitFor } from "../../support/processes.js";
import { conductorHarness, leakedEnv } from "./harness.js";
import type { ConductorHarness } from "./harness.js";

const promptFile = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../prompts/${name}`, import.meta.url)), "utf8").trim();

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

// How long the fake took to think varies from run to run, so only the shape of the label is compared.
const shown = ({ kind, content, meta }: ChatMessage) => ({
  kind,
  content: content.replace(/^Thought for \d+s$/, "Thought for Ns"),
  meta,
});

function activities(events: readonly BusEvent[], turnId: string): string[] {
  return events.flatMap((event) =>
    event.type === "chat.activity" && event.turnId === turnId ? [event.text] : [],
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
  it("runs a turn that creates tasks through MCP, storing each text block and a row for each step it took", async () => {
    const harness = await conductorHarness({
      scenario: {
        turns: [
          conductorTurn("add the parser tasks", [
            { kind: "thinking", tokens: 1200 },
            { kind: "read", path: "README.md" },
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

    const blocks = ["Adding them now.", "I added lexer and parser; parser waits for lexer."];
    expect(message).toMatchObject({ kind: "user", content: "add the parser tasks", turnId });
    expect(turn.map(shown)).toEqual([
      { kind: "user", content: "add the parser tasks", meta: null },
      {
        kind: "step",
        content: "Thought for Ns",
        meta: { step: "thinking", status: "done", detail: null },
      },
      {
        kind: "step",
        content: "Read README.md",
        meta: { step: "tool", status: "done", detail: "1\t# Demo\n2\t" },
      },
      { kind: "conductor", content: blocks[0], meta: null },
      {
        kind: "step",
        content: "Added 2 tasks",
        meta: { step: "tool", status: "done", detail: null },
      },
      { kind: "conductor", content: blocks[1], meta: null },
    ]);
    expect(harness.db.tasks.get("parser")).toMatchObject({ status: "pending", deps: ["lexer"] });
    expect(deltas(harness.events, turnId).length).toBeGreaterThan(2);
    expect(deltas(harness.events, turnId).join("")).toBe(blocks.join(""));
    expect(activities(harness.events, turnId)).toEqual([
      ...[
        "100",
        "200",
        "300",
        "400",
        "500",
        "600",
        "700",
        "800",
        "900",
        "1.0k",
        "1.1k",
        "1.2k",
      ].map((amount) => `Thinking (${amount} tokens)`),
      "Reading a file",
      "Reading README.md",
      "Making changes",
    ]);
    expect(
      harness.events.flatMap((event) =>
        event.type === "chat.message" && event.message.turnId === turnId
          ? [
              `${event.message.kind}:${stepMetaSchema.safeParse(event.message.meta).data?.status ?? ""}`,
            ]
          : [],
      ),
    ).toEqual([
      "user:",
      "step:running",
      "step:done",
      "step:running",
      "step:done",
      "conductor:",
      "step:running",
      "step:done",
      "conductor:",
    ]);

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
      systemPrompt: harness.systemPromptFile,
      settings: JSON.stringify({ attribution: { commit: "", pr: "", sessionUrl: false } }),
    });
    expect(argv).not.toContain("--bare");
    expect(invocation.cwd).toBe(realpathSync(harness.repo.path));
    expect(invocation.pgid).toBe(invocation.pid);
    for (const name of Object.keys(leakedEnv)) expect(invocation.env).not.toHaveProperty(name);
    expect(harness.registry.tracked()).toContainEqual(
      expect.objectContaining({ kind: "conductor", pid: invocation.pid }),
    );

    expect(readFileSync(harness.systemPromptFile, "utf8")).toBe(
      `${promptFile("conductor.md")}\n\n${promptFile("planner.md")}\n`,
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

  it("asks the owner a multiple-choice question as its own card, without a step row", async () => {
    const options = [
      {
        label: "Browser extension (recommended)",
        description: "Fill passwords where you use them.",
      },
      { label: "Desktop app", description: "A separate window for your vault." },
    ];
    const harness = await conductorHarness({
      scenario: {
        turns: [
          conductorTurn("plan a password manager", [
            reply("One decision first."),
            {
              kind: "mcp",
              tool: "ask_owner",
              arguments: { question: "What should we build first?", header: "First", options },
            },
          ]),
        ],
      },
    });

    const { turnId } = await send(harness, "plan a password manager");
    const turn = await harness.waitForTurnEnd(turnId);

    expect(turn.map(({ kind, content, meta }) => ({ kind, content, meta }))).toEqual([
      { kind: "user", content: "plan a password manager", meta: null },
      { kind: "conductor", content: "One decision first.", meta: null },
      {
        kind: "question",
        content: "What should we build first?",
        meta: { header: "First", options, multiSelect: false },
      },
    ]);
  });

  it("keeps which question each answer belongs to on the owner's message", async () => {
    const harness = await conductorHarness({ scenario: { turns: [fallbackTurn] } });
    const answers = [
      { questionId: 4, answer: "TypeScript" },
      { questionId: 5, answer: "Chrome, Firefox" },
    ];

    const { message } = chatTurnSchema.parse(
      await harness.post("/api/chat", {
        text: "Tech stack: TypeScript\nBrowsers: Chrome, Firefox",
        answers,
      }),
    );

    expect(message.meta).toEqual({ answers });
    expect(harness.db.chat.get(message.id)?.meta).toEqual({ answers });
  });

  it("records a stop that comes before the reply has said anything", async () => {
    const harness = await conductorHarness({
      scenario: {
        turns: [conductorTurn("think it over", [{ kind: "thinking", tokens: 5000, streamMs: 50 }])],
      },
    });

    const { turnId } = await send(harness, "think it over");
    await waitFor(() => activities(harness.events, turnId).length >= 2, 15_000);
    expect(stoppedSchema.parse(await harness.post("/api/chat/stop"))).toEqual({ stopped: true });
    const turn = await harness.waitForTurnEnd(turnId);

    expect(turn.map(shown)).toEqual([
      { kind: "user", content: "think it over", meta: null },
      {
        kind: "step",
        content: "Thought for Ns",
        meta: { step: "thinking", status: "done", detail: null },
      },
      { kind: "conductor", content: "", meta: { stopped: true } },
    ]);
  });

  it("starts a new conversation that stops the running reply and carries nothing from the old one", async () => {
    const harness = await conductorHarness({
      scenario: {
        turns: [
          conductorTurn("think it over", [{ kind: "thinking", tokens: 5000, streamMs: 50 }]),
          fallbackTurn,
        ],
      },
    });
    const old = harness.db.conversations.active().id;
    harness.db.conductorSessions.open("rolled-over", old);
    harness.db.conductorSessions.end("rolled-over", "The owner wants a lexer first.");

    const first = await send(harness, "think it over");
    await waitFor(() => activities(harness.events, first.turnId).length >= 2, 15_000);
    const view = chatViewSchema.parse(await harness.post("/api/conversations"));
    const stopped = await harness.waitForTurnEnd(first.turnId);
    const next = await send(harness, "hello again");
    const answered = await harness.waitForTurnEnd(next.turnId);

    expect(view).toMatchObject({ replying: false, messages: [] });
    expect(view.conversationId).not.toBe(old);
    expect(view.conversations.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: view.conversationId, title: null },
      { id: old, title: "think it over" },
    ]);
    expect(stopped.map(({ kind, conversationId }) => [kind, conversationId])).toEqual([
      ["user", old],
      ["step", old],
      ["conductor", old],
    ]);
    expect(stopped.at(-1)?.meta).toEqual({ stopped: true });
    expect(
      answered.map(({ kind, content, conversationId }) => [kind, content, conversationId]),
    ).toEqual([
      ["user", "hello again", view.conversationId],
      ["conductor", "Noted.", view.conversationId],
    ]);
    expect(harness.db.conversations.get(view.conversationId)?.title).toBe("hello again");

    const [oldProcess, newProcess] = await harness.env.invocations();
    const oldSession = flagValue(oldProcess?.argv ?? [], "--session-id");
    const newSession = flagValue(newProcess?.argv ?? [], "--session-id");
    expect(newSession).toBeDefined();
    expect(newSession).not.toBe(oldSession);
    expect(newProcess?.argv).not.toContain("--resume");
    expect(harness.db.conductorSessions.latest(view.conversationId)?.id).toBe(newSession);
    const [oldPrompt, newPrompt] = await receivedPrompts(harness);
    expect(oldPrompt).toContain("The owner wants a lexer first.");
    expect(newPrompt).not.toContain("<summary>");
  });

  it("keeps one empty conversation however often a new one is asked for", async () => {
    const harness = await conductorHarness({ scenario: { turns: [fallbackTurn] } });

    const first = chatViewSchema.parse(await harness.post("/api/conversations"));
    const second = chatViewSchema.parse(await harness.post("/api/conversations"));

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.conversations).toHaveLength(1);
  });

  it("deletes an earlier conversation with its messages and Claude sessions, leaving the open one as it was", async () => {
    const harness = await conductorHarness({ scenario: { turns: [fallbackTurn] } });
    const first = await send(harness, "plan the lexer");
    await harness.waitForTurnEnd(first.turnId);
    const earlier = harness.db.conversations.active().id;
    chatViewSchema.parse(await harness.post("/api/conversations"));
    const second = await send(harness, "plan the parser");
    await harness.waitForTurnEnd(second.turnId);

    const view = chatViewSchema.parse(
      await harness.delete(`/api/conversations/${String(earlier)}`),
    );

    expect(view.conversationId).not.toBe(earlier);
    expect(view.conversations.map(({ title }) => title)).toEqual(["plan the parser"]);
    expect(view.messages.map(({ content }) => content)).toEqual(["plan the parser", "Noted."]);
    expect(harness.db.chat.listConversation(earlier)).toEqual([]);
    expect(harness.db.conductorSessions.latest(earlier)).toBeNull();
    expect(harness.events).toContainEqual({
      type: "conversation.deleted",
      conversationId: earlier,
    });
    await expect(harness.delete(`/api/conversations/${String(earlier)}`)).rejects.toThrow(
      `no conversation ${String(earlier)}`,
    );
  });

  it("deleting the open conversation stops its reply, expires what it asked and opens an empty one", async () => {
    const harness = await conductorHarness({
      scenario: {
        turns: [
          conductorTurn("use sonnet", [
            { kind: "mcp", tool: "set_config", arguments: { models: { worker: "sonnet" } } },
            { kind: "thinking", tokens: 5000, streamMs: 50 },
          ]),
        ],
      },
    });
    const deleted = harness.db.conversations.active().id;

    await send(harness, "use sonnet");
    const [pending] = await waitFor(() => {
      const proposals = harness.db.proposals.listPending();
      return proposals.length > 0 ? proposals : undefined;
    }, 15_000);
    const view = chatViewSchema.parse(
      await harness.delete(`/api/conversations/${String(deleted)}`),
    );

    expect(view).toMatchObject({ replying: false, messages: [] });
    expect(view.conversationId).not.toBe(deleted);
    expect(harness.db.proposals.get(pending?.id ?? 0)?.status).toBe("expired");
    expect(harness.db.chat.list()).toEqual([]);
    expect(harness.config().models.worker).not.toBe("sonnet");
  });

  it("carries on in an earlier conversation by resuming its own Claude session", async () => {
    const harness = await conductorHarness({ scenario: { turns: [fallbackTurn] } });

    const first = await send(harness, "plan the lexer");
    await harness.waitForTurnEnd(first.turnId);
    const earlier = harness.db.conversations.active().id;
    chatViewSchema.parse(await harness.post("/api/conversations"));
    const other = await send(harness, "something else");
    await harness.waitForTurnEnd(other.turnId);
    const view = chatViewSchema.parse(
      await harness.post(`/api/conversations/${String(earlier)}/open`),
    );
    const back = await send(harness, "where were we?");
    await harness.waitForTurnEnd(back.turnId);

    expect(view.conversationId).toBe(earlier);
    expect(view.messages.map(({ kind, content }) => `${kind}: ${content}`)).toEqual([
      "user: plan the lexer",
      "conductor: Noted.",
    ]);
    const [firstRun, otherRun, backRun] = await harness.env.invocations();
    const earlierSession = flagValue(firstRun?.argv ?? [], "--session-id");
    expect(flagValue(otherRun?.argv ?? [], "--session-id")).not.toBe(earlierSession);
    expect(flagValue(backRun?.argv ?? [], "--resume")).toBe(earlierSession);
    expect(
      harness
        .messages(back.turnId)
        .map(({ conversationId, conductorSession }) => [conversationId, conductorSession]),
    ).toEqual([
      [earlier, earlierSession],
      [earlier, earlierSession],
    ]);
    expect(
      chatViewSchema.parse(await harness.get("/api/chat")).conversations.map(({ title }) => title),
    ).toEqual(["plan the lexer", "something else"]);
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
      () => harness.messages(first.turnId).some((message) => message.kind === "conductor"),
      15_000,
    );
    const second = await send(harness, "skip the docs");
    const turn = await harness.waitForTurnEnd(first.turnId);

    expect(second.turnId).toBe(first.turnId);
    expect(turn.map(({ kind, content }) => ({ kind, content }))).toEqual([
      { kind: "user", content: "plan the release" },
      { kind: "conductor", content: "Looking at the release now." },
      { kind: "user", content: "skip the docs" },
      { kind: "conductor", content: "OK, leaving the docs out." },
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
    const conversation = harness.db.conductorSessions.latest(harness.db.conversations.active().id);
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
