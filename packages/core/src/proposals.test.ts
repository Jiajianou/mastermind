import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { ActionError, builtinActions, createActionRegistry } from "./actions/index.js";
import { actionTools } from "./conductor/index.js";
import { loadConfig, setConfig } from "./config/index.js";
import type { BusEvent, Config } from "./contracts/index.js";
import { openDb } from "./db/index.js";
import type { Clock, Db } from "./db/index.js";
import { createEventBus } from "./events.js";
import { createProposalGate, proposalLifetimeMs } from "./proposals.js";
import type { GateableTool, ProposalGate } from "./proposals.js";
import { makeTempDir } from "./testing/temp-dir.js";

interface Harness {
  db: Db;
  gate: ProposalGate;
  events: BusEvent[];
  config(): Config;
  advance(ms: number): void;
}

async function setup(): Promise<Harness> {
  const root = await makeTempDir();
  const context = { repoRoot: root, homeDir: join(root, "home") };
  let now = new Date("2026-10-06T12:00:00.000Z");
  const clock: Clock = { now: () => now };
  const db = openDb(join(root, "db.sqlite"), { clock });
  onTestFinished(() => {
    db.close();
  });
  const bus = createEventBus();
  const events: BusEvent[] = [];
  bus.subscribe((event) => events.push(event));
  let config = await loadConfig(context);
  const actions = createActionRegistry(
    {
      db,
      bus,
      config: {
        async set(change) {
          config = await setConfig(context, change);
          return config;
        },
      },
    },
    builtinActions,
  );
  await actions.invoke("createTasks", {
    tasks: [{ id: "sched-prio", title: "Priorities", goal: "g", acceptance: "true", touches: [] }],
  });
  events.length = 0;
  const gate = createProposalGate({
    db,
    bus,
    actions,
    clock,
    tools: actionTools,
    confirmList: () => config.conductor.confirm,
    activeTurn: () => null,
  });
  return {
    db,
    gate,
    events,
    config: () => config,
    advance: (ms) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

function tool(name: string): GateableTool {
  const found = actionTools.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

const eventTypes = (events: readonly BusEvent[]) => events.map((event) => event.type);

async function proposeWorkers(harness: Harness, maxWorkers: number): Promise<number> {
  const outcome = await harness.gate.run(tool("set_config"), { maxWorkers });
  if (outcome.kind !== "awaiting_confirmation") throw new Error("set_config was not gated");
  harness.events.length = 0;
  return outcome.proposal.id;
}

describe("proposal gate", () => {
  it.each([
    { name: "hold", input: { taskId: "sched-prio" }, gated: false },
    { name: "set_config", input: { maxWorkers: 3 }, gated: true },
  ])("gates $name only when it is on the confirm list", async ({ name, input, gated }) => {
    const harness = await setup();

    const outcome = await harness.gate.run(tool(name), input);

    expect(outcome.kind).toBe(gated ? "awaiting_confirmation" : "done");
    expect(harness.db.proposals.listPending()).toHaveLength(gated ? 1 : 0);
    expect(harness.db.tasks.get("sched-prio")?.held).toBe(!gated && name === "hold");
    expect(harness.config().maxWorkers).toBe("auto");
    expect(eventTypes(harness.events)).toEqual(
      gated ? ["proposal.updated", "chat.message"] : ["task.updated"],
    );
  });

  it("stores a gated call as a pending proposal with its validated args and a question in the chat", async () => {
    const harness = await setup();

    const outcome = await harness.gate.run(tool("set_config"), { maxWorkers: 3 });

    expect(outcome).toMatchObject({
      kind: "awaiting_confirmation",
      proposal: { action: "setConfig", args: { maxWorkers: 3 }, status: "pending" },
      question: "Change maxWorkers in settings?",
    });
    expect(harness.db.chat.list()).toMatchObject([
      { kind: "proposal", content: "Change maxWorkers in settings?" },
    ]);
  });

  it("refuses invalid input for a gated tool without storing a proposal", async () => {
    const harness = await setup();

    await expect(harness.gate.run(tool("set_config"), { maxWorkers: 0 })).rejects.toBeInstanceOf(
      ActionError,
    );
    expect(harness.db.proposals.listPending()).toEqual([]);
  });

  it("runs a confirmed action exactly once, even when confirmed twice at the same time and again later", async () => {
    const harness = await setup();
    const proposalId = await proposeWorkers(harness, 3);

    const [first, second] = await Promise.all([
      harness.gate.confirm(proposalId),
      harness.gate.confirm(proposalId),
    ]);
    const again = await harness.gate.confirm(proposalId);

    expect(first).toMatchObject({ status: "confirmed", result: { ok: true } });
    expect(second).toEqual(first);
    expect(again).toEqual(first);
    expect(harness.config().maxWorkers).toBe(3);
    expect(eventTypes(harness.events)).toEqual([
      "config.updated",
      "proposal.updated",
      "chat.message",
    ]);
    expect(harness.db.chat.list().at(-1)).toMatchObject({
      kind: "system",
      content: "Change maxWorkers in settings: confirmed by the owner and done.",
      meta: { proposalId, status: "confirmed" },
    });
  });

  it("records a confirmed action that fails, and tells the Conductor why", async () => {
    const harness = await setup();
    await harness.gate.run(tool("set_config"), { conductor: { confirm: ["retry"] } });
    await harness.gate.confirm(1);
    const outcome = await harness.gate.run(tool("retry"), { taskId: "sched-prio" });
    if (outcome.kind !== "awaiting_confirmation") throw new Error("retry was not gated");

    const decided = await harness.gate.confirm(outcome.proposal.id);

    expect(decided).toMatchObject({ status: "confirmed", result: { ok: false } });
    expect(harness.db.tasks.get("sched-prio")?.status).toBe("pending");
    expect(harness.db.chat.list().at(-1)?.content).toBe(
      'Retry sched-prio: confirmed by the owner, but it failed: task "sched-prio" cannot move from pending to pending',
    );
  });

  it("rejects a proposal without running it, and a later confirm changes nothing", async () => {
    const harness = await setup();
    const proposalId = await proposeWorkers(harness, 3);

    const rejected = harness.gate.reject(proposalId);
    const confirmed = await harness.gate.confirm(proposalId);

    expect(rejected.status).toBe("rejected");
    expect(confirmed).toEqual(rejected);
    expect(harness.config().maxWorkers).toBe("auto");
    expect(eventTypes(harness.events)).toEqual(["proposal.updated", "chat.message"]);
    expect(harness.db.chat.list().at(-1)?.content).toBe(
      "Change maxWorkers in settings: declined by the owner.",
    );
  });

  it("expires a proposal left unanswered for its lifetime, so it can no longer be confirmed", async () => {
    const harness = await setup();
    const staleId = await proposeWorkers(harness, 3);
    harness.advance(proposalLifetimeMs - 1);
    const freshId = await proposeWorkers(harness, 4);
    harness.advance(1);

    const expired = harness.gate.expireStale();
    const confirmed = await harness.gate.confirm(staleId);

    expect(expired.map((proposal) => proposal.id)).toEqual([staleId]);
    expect(confirmed.status).toBe("expired");
    expect(harness.db.proposals.get(freshId)?.status).toBe("pending");
    expect(harness.config().maxWorkers).toBe("auto");
    expect(harness.db.chat.list().at(-1)?.content).toBe(
      "Change maxWorkers in settings: expired without an answer from the owner.",
    );
  });

  it("expires a stale proposal at the moment it is confirmed, before any sweep", async () => {
    const harness = await setup();
    const proposalId = await proposeWorkers(harness, 3);
    harness.advance(proposalLifetimeMs);

    const decided = await harness.gate.confirm(proposalId);

    expect(decided.status).toBe("expired");
    expect(harness.config().maxWorkers).toBe("auto");
  });

  it("follows a change to the confirm list in config from the next call", async () => {
    const harness = await setup();
    const proposalId = await proposeWorkers(harness, 3);
    expect(harness.gate.isGated("hold")).toBe(false);

    const change = { conductor: { confirm: ["hold"] } };
    const outcome = await harness.gate.run(tool("set_config"), change);
    if (outcome.kind !== "awaiting_confirmation") throw new Error("set_config was not gated");
    await harness.gate.confirm(outcome.proposal.id);

    expect(harness.gate.isGated("hold")).toBe(true);
    expect(harness.gate.isGated("set_config")).toBe(false);
    expect((await harness.gate.run(tool("hold"), { taskId: "sched-prio" })).kind).toBe(
      "awaiting_confirmation",
    );
    expect(harness.db.chat.list().at(-1)).toMatchObject({
      kind: "proposal",
      content: "Hold sched-prio?",
      meta: { taskId: "sched-prio" },
    });
    expect((await harness.gate.run(tool("set_config"), { maxAttempts: 5 })).kind).toBe("done");
    expect(harness.config().maxAttempts).toBe(5);
    expect(harness.db.tasks.get("sched-prio")?.held).toBe(false);
    expect(harness.db.proposals.get(proposalId)?.status).toBe("pending");
  });

  it("answers not_found for a proposal that does not exist", async () => {
    const harness = await setup();

    await expect(harness.gate.confirm(42)).rejects.toMatchObject({ code: "not_found" });
    expect(() => harness.gate.reject(42)).toThrow(ActionError);
  });
});
