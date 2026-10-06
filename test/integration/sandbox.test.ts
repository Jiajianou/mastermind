import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createActionRegistry } from "@mastermind/core/actions";
import { actionTools } from "@mastermind/core/conductor";
import { defaultConfig, setConfig } from "@mastermind/core/config";
import { proposalMetaSchema } from "@mastermind/core/contracts";
import type { Config } from "@mastermind/core/contracts";
import { systemClock } from "@mastermind/core/db";
import { createProposalGate } from "@mastermind/core/proposals";
import {
  allowSandboxHostAction,
  allowSandboxHostDescriber,
  offerBlockedHosts,
} from "@mastermind/core/sandbox";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { checksHarness } from "./checks/harness.js";
import { onCleanup } from "../support/cleanup.js";
import type { Step } from "../support/fake-claude.js";

const deniedCurl = (...hosts: string[]): Step => ({
  kind: "bash",
  command: [
    "printf 'curl: (56) CONNECT tunnel failed, response 403\\n<sandbox_violations>\\n'",
    ...hosts.map(
      (host) => `printf 'deny network-outbound ${host}:443 (host is not on the allow list)\\n'`,
    ),
    "printf '</sandbox_violations>\\n'",
    "exit 56",
  ].join("; "),
});

describe("blocked access offers", () => {
  it("offers each blocked host not yet allowed once after the task fails, and Allow saves it to config", async () => {
    const harness = await checksHarness({
      config: { maxAttempts: 2 },
      scenario: {
        turns: [
          {
            match: { role: "worker" },
            steps: [
              deniedCurl("github.com", "registry.npmjs.org"),
              { kind: "text", text: "Done." },
            ],
          },
          {
            match: { role: "fixer" },
            steps: [deniedCurl("github.com", "pypi.org"), { kind: "text", text: "Done." }],
          },
          {
            match: { flags: ["--json-schema"] },
            steps: [
              { kind: "structuredOutput", output: { flaky: false, reason: "Missing file." } },
            ],
          },
        ],
      },
    });
    const context = { repoRoot: harness.repo.path, homeDir: harness.env.home };
    const defaults = defaultConfig(context);
    let config: Config = {
      ...defaults,
      sandbox: { ...defaults.sandbox, allowedDomains: ["*.npmjs.org"] },
    };
    const actions = createActionRegistry(
      {
        db: harness.db,
        bus: harness.bus,
        config: {
          async set(change) {
            config = await setConfig(context, change);
            return config;
          },
        },
      },
      [allowSandboxHostAction(() => config)],
    );
    const gate = createProposalGate({
      db: harness.db,
      bus: harness.bus,
      actions,
      clock: systemClock,
      tools: actionTools,
      describers: [allowSandboxHostDescriber],
      confirmList: () => [],
      activeTurn: () => null,
    });
    onCleanup(
      offerBlockedHosts({ db: harness.db, bus: harness.bus, gate, sandbox: () => config.sandbox }),
    );

    await harness.startTask("fetcher");
    await harness.waitForStatus("fetcher", "blocked");

    const offers = harness.db.chat.list().filter((message) => message.kind === "proposal");
    expect(offers.map((message) => message.content)).toEqual([
      "fetcher couldn't reach github.com. Allow it for this project?",
      "fetcher couldn't reach pypi.org. Allow it for this project?",
    ]);
    const [github] = offers.map((message) => proposalMetaSchema.parse(message.meta));
    expect(github?.confirmLabel).toBe("Allow");

    const allowed = await gate.confirm(github?.proposalId ?? 0);
    expect(allowed.status).toBe("confirmed");
    const saved: unknown = parse(
      await readFile(join(harness.repo.path, ".mastermind", "config.yaml"), "utf8"),
    );
    expect(saved).toMatchObject({ sandbox: { allowedDomains: ["*.npmjs.org", "github.com"] } });
    expect(harness.db.chat.list().at(-1)?.content).toBe(
      "Allow github.com for this project: confirmed by the owner and done.",
    );
  });
});
