import { defineAction } from "./actions/index.js";
import type { Config, Task } from "./contracts/index.js";
import { allowSandboxHostInputSchema, isEditingRole } from "./contracts/index.js";
import type { Db } from "./db/index.js";
import type { EventBus } from "./events.js";
import type { ActionDescriber, ProposalGate } from "./proposals.js";
import { createStreamParser } from "./sessions/index.js";

export const allowSandboxHostActionName = "allowSandboxHost";

const violationBlock = /<sandbox_violations>([\s\S]*?)<\/sandbox_violations>/g;
const networkDenial = /^deny network-outbound ([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d+)?(?:\s|$)/i;

export function deniedHosts(output: string): string[] {
  const hosts = [...output.matchAll(violationBlock)].flatMap(([, block = ""]) =>
    block.split("\n").flatMap((line) => {
      const host = networkDenial.exec(line.trim())?.[1];
      return host === undefined ? [] : [host.toLowerCase()];
    }),
  );
  return [...new Set(hosts)];
}

export function hostAllowed(host: string, allowedDomains: readonly string[]): boolean {
  return allowedDomains.some((domain) => {
    const allowed = domain.toLowerCase();
    return allowed.startsWith("*.") ? host.endsWith(allowed.slice(1)) : host === allowed;
  });
}

const hostArgs = (input: unknown): string =>
  allowSandboxHostInputSchema.safeParse(input).data?.host ?? "a host";

export const allowSandboxHostDescriber: ActionDescriber = {
  action: allowSandboxHostActionName,
  describe: (input) => `Allow ${hostArgs(input)} for this project`,
};

export function allowSandboxHostAction(current: () => Config) {
  let writing: Promise<unknown> = Promise.resolve();
  return defineAction({
    name: allowSandboxHostActionName,
    description:
      "Add a host to sandbox.allowedDomains in .mastermind/config.yaml, so sandboxed sessions can reach it.",
    input: allowSandboxHostInputSchema,
    emits: ["config.updated"],
    // Appends are serialised, so two hosts allowed together both end up in the list.
    handler: ({ host }, scope) => {
      const write = writing.then(async () => {
        const { allowedDomains } = current().sandbox;
        if (allowedDomains.includes(host)) return current();
        const config = await scope.config.set({
          sandbox: { allowedDomains: [...allowedDomains, host] },
        });
        scope.emit({ type: "config.updated", config });
        return config;
      });
      writing = write.catch(() => undefined);
      return write;
    },
  });
}

export interface BlockedAccessOptions {
  db: Db;
  bus: EventBus;
  gate: Pick<ProposalGate, "offer">;
  sandbox: () => Config["sandbox"];
}

function hostsDeniedToTask(db: Db, taskId: string): string[] {
  const hosts = db.sessions
    .listForTask(taskId)
    .filter(isEditingRole)
    .flatMap((session) =>
      db.events
        .listForSession(session.id)
        .filter((event) => event.type === "error")
        .flatMap((event) => {
          const { details } = createStreamParser().parseLine(event.payload);
          return details.line === "tool_result" ? deniedHosts(details.output) : [];
        }),
    );
  return [...new Set(hosts)];
}

function offeredHosts(db: Db): Set<string> {
  return new Set(
    db.proposals
      .listForAction(allowSandboxHostActionName)
      .flatMap((proposal) => allowSandboxHostInputSchema.safeParse(proposal.args).data?.host ?? []),
  );
}

const failed = (previous: Task | undefined, task: Task): boolean =>
  previous !== undefined &&
  (task.attempts > previous.attempts ||
    (task.status === "blocked" && previous.status !== "blocked"));

// Denials are silent; a host is only offered once a task has failed after the sandbox blocked it (decision 9).
export function offerBlockedHosts(options: BlockedAccessOptions): () => void {
  const { db, bus } = options;
  const tasks = new Map(db.tasks.list().map((task) => [task.id, task]));

  function offerHostsOf(taskId: string): void {
    const sandbox = options.sandbox();
    if (!sandbox.enabled) return;
    const offered = offeredHosts(db);
    for (const host of hostsDeniedToTask(db, taskId)) {
      if (offered.has(host) || hostAllowed(host, sandbox.allowedDomains)) continue;
      options.gate.offer({
        action: allowSandboxHostActionName,
        args: { host },
        question: `${taskId} couldn't reach ${host}. Allow it for this project?`,
        confirmLabel: "Allow",
      });
    }
  }

  return bus.subscribe((event) => {
    if (event.type !== "task.updated") return;
    const previous = tasks.get(event.taskId);
    tasks.set(event.taskId, event.task);
    if (failed(previous, event.task)) offerHostsOf(event.taskId);
  });
}
