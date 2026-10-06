import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createActionRegistry } from "@mastermind/core/actions";
import type { ActionRegistry } from "@mastermind/core/actions";
import { findAttribution } from "@mastermind/core/attribution";
import { createClaudeCli } from "@mastermind/core/claude";
import { actionTools, postEventLines } from "@mastermind/core/conductor";
import { defaultConfig, resolveConfig } from "@mastermind/core/config";
import type { ResolvedConfig } from "@mastermind/core/config";
import type { BranchRebase, BusEvent } from "@mastermind/core/contracts";
import { openDb, systemClock } from "@mastermind/core/db";
import type { Db } from "@mastermind/core/db";
import { createEventBus } from "@mastermind/core/events";
import type { EventBus } from "@mastermind/core/events";
import { createGit } from "@mastermind/core/git";
import { createProcessRegistry } from "@mastermind/core/procs";
import { createProposalGate } from "@mastermind/core/proposals";
import type { ProposalGate } from "@mastermind/core/proposals";
import {
  createOwnerRebaser,
  offerOwnerRebase,
  ownerCopyName,
  rebaseOwnerBranchAction,
} from "@mastermind/core/rebase";
import type { OwnerRebaser } from "@mastermind/core/rebase";
import { createBranchFixer, createSessionSpawner } from "@mastermind/core/sessions";
import { describe, expect, it } from "vitest";
import { onCleanup } from "../../support/cleanup.js";
import type { Scenario } from "../../support/fake-claude.js";
import { isolatedEnv } from "../../support/isolated-env.js";
import type { IsolatedEnv } from "../../support/isolated-env.js";
import { waitFor } from "../../support/processes.js";
import { createTempRepo, owner } from "../../support/temp-repo.js";
import type { TempRepo } from "../../support/temp-repo.js";

const promptsDir = fileURLToPath(new URL("../../../prompts/", import.meta.url));

const makefile = `build:
\t@echo built
test:
\t@echo tests passed
`;

interface OwnerHarness {
  env: IsolatedEnv;
  repo: TempRepo;
  db: Db;
  bus: EventBus;
  config: ResolvedConfig;
  rebaser: OwnerRebaser;
  actions: ActionRegistry;
  gate: ProposalGate;
  events: BusEvent[];
  errors: unknown[];
  finished(): Promise<BranchRebase>;
}

async function ownerHarness(scenario: Scenario = { turns: [] }): Promise<OwnerHarness> {
  const repo = await createTempRepo({
    files: { "README.md": "# Demo\n", Makefile: makefile, "src/app.ts": "export {};\n" },
  });
  await repo.git("switch", "--quiet", "--create", "dev");
  const env = await isolatedEnv();
  await env.writeScenario(scenario);
  const context = { repoRoot: repo.path, homeDir: env.home };
  const config = resolveConfig(
    {
      ...defaultConfig(context),
      worktreeDir: join(env.worktreeRoot, "demo"),
      commands: { setup: "", build: "make build", test: "make test" },
    },
    { ...context, plan: "max" },
  );
  const db = openDb(join(env.root, "db.sqlite"));
  const bus = createEventBus();
  const events: BusEvent[] = [];
  const errors: unknown[] = [];
  const onError = (error: unknown) => errors.push(error);
  bus.subscribe((event) => events.push(event));
  const registry = createProcessRegistry();
  const git = createGit({ registry, env: env.env });
  const logsDir = join(env.root, "logs");
  const spawner = createSessionSpawner({
    db,
    bus,
    cli: createClaudeCli({ registry, env: env.env }),
    logsDir,
    onError,
  });
  const fixer = createBranchFixer({
    db,
    bus,
    spawner,
    backoff: { reportUsageLimit: () => new Date(), reportSuccess: () => undefined },
    config: () => config,
    repoRoot: repo.path,
    homeDir: env.home,
    promptsDir,
    pathGuardCommand: ["node", "/opt/mastermind/path-guard.js"],
  });
  const rebaser = createOwnerRebaser({
    git,
    bus,
    registry,
    env: env.env,
    repoRoot: repo.path,
    logsDir,
    config: () => config,
    fixer,
    claudeAllowed: () => true,
    signedIn: () => Promise.resolve(true),
    onError,
  });
  const actions = createActionRegistry(
    { db, bus, config: { set: () => Promise.reject(new Error("config is fixed in tests")) } },
    [rebaseOwnerBranchAction(rebaser)],
  );
  const gate = createProposalGate({
    db,
    bus,
    actions,
    clock: systemClock,
    tools: actionTools,
    confirmList: () => config.conductor.confirm,
    activeTurn: () => null,
  });
  const stopOffers = offerOwnerRebase({ db, bus, gate, rebaser, onError });
  const stopEventLines = postEventLines({ db, bus, mainBranch: () => config.mainBranch });
  rebaser.start();
  onCleanup(() => {
    stopOffers();
    stopEventLines();
    rebaser.stop();
    registry.killAllSync();
    db.close();
  });

  return {
    env,
    repo,
    db,
    bus,
    config,
    rebaser,
    actions,
    gate,
    events,
    errors,
    finished: () =>
      waitFor(async () => {
        const { rebase } = await rebaser.branch();
        return rebase !== null && rebase.status !== "running" && rebase;
      }, 25_000),
  };
}

async function commit(repo: TempRepo, path: string, content: string, ...args: string[]) {
  await writeFile(join(repo.path, path), content);
  await repo.git("add", "--all");
  await repo.git("commit", "--quiet", ...args);
}

async function commitOnMain(repo: TempRepo, path: string, content: string, subject: string) {
  await repo.git("switch", "--quiet", "main");
  await commit(repo, path, content, "--message", subject);
  await repo.git("switch", "--quiet", "dev");
}

const ownCommits = (repo: TempRepo, range: string) =>
  repo.git("log", "--reverse", "--format=%an <%ae>%n%B%n--", range);

describe("rebasing the owner's branch", () => {
  it("puts the owner's commits on main unchanged, with linear history", async () => {
    const harness = await ownerHarness();
    const { repo } = harness;
    await commit(repo, "notes.txt", "notes\n", "--message", "Add notes\n\nWhy the notes exist.");
    await commit(
      repo,
      "src/app.ts",
      "export const app = 1;\n",
      "--author",
      "Ada <ada@example.com>",
      "--message",
      "Export the app",
    );
    const initial = await repo.git("rev-parse", "main");
    const before = await ownCommits(repo, "main..dev");
    await commitOnMain(repo, "other.txt", "other\n", "main: other change");
    const moved = await repo.git("rev-parse", "main");
    await repo.git("config", "remote.origin.url", join(repo.path, "no-such-remote"));
    await repo.git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
    await repo.git("config", "branch.main.remote", "origin");
    await repo.git("config", "branch.main.merge", "refs/heads/main");
    await repo.git("update-ref", "refs/remotes/origin/main", initial);

    const started = await harness.actions.invoke("rebaseOwnerBranch", {});
    expect(started).toMatchObject({ branch: "dev", status: "running" });
    const rebase = await harness.finished();

    expect(rebase.status).toBe("succeeded");
    expect(rebase.outcome).toBe(
      "Rebased dev onto main: 2 commits of yours are on main now. main is 3 commits ahead of origin/main.",
    );
    expect(await ownCommits(repo, "main~2..main")).toBe(before);
    expect(await repo.git("rev-parse", "main~2")).toBe(moved);
    expect(await repo.git("rev-list", "--merges", "main")).toBe("");
    expect(await repo.git("log", "--format=%cn <%ce>", "main~2..main")).toBe(
      [`${owner.name} <${owner.email}>`, `${owner.name} <${owner.email}>`].join("\n"),
    );
    expect(await repo.git("rev-parse", "dev")).toBe(await repo.git("rev-parse", "main"));
    expect(await repo.git("symbolic-ref", "--short", "HEAD")).toBe("dev");
    expect(await repo.git("status", "--porcelain")).toBe("");
    expect(await repo.git("rev-parse", "refs/remotes/origin/main")).toBe(initial);
    expect(await repo.git("for-each-ref", "refs/mastermind-branches/")).toBe("");
    expect(existsSync(join(harness.config.worktreeDir, ownerCopyName))).toBe(false);
    expect(harness.events).toContainEqual({
      type: "main.moved",
      branch: "main",
      commit: await repo.git("rev-parse", "main"),
    });
    expect(harness.db.chat.list().map((message) => message.content)).toContain(rebase.outcome);
    expect(harness.errors).toEqual([]);
  });

  it("refuses a checkout with uncommitted changes and moves nothing", async () => {
    const harness = await ownerHarness();
    const { repo } = harness;
    await commit(repo, "notes.txt", "notes\n", "--message", "Add notes");
    await writeFile(join(repo.path, "README.md"), "# Demo, edited\n");
    const main = await repo.git("rev-parse", "main");
    const dev = await repo.git("rev-parse", "dev");

    await expect(harness.actions.invoke("rebaseOwnerBranch", {})).rejects.toMatchObject({
      code: "conflict",
      message: "Your checkout of dev has uncommitted changes. Commit them first, then ask again.",
    });

    expect(await repo.git("rev-parse", "main")).toBe(main);
    expect(await repo.git("rev-parse", "dev")).toBe(dev);
    expect((await harness.rebaser.branch()).rebase).toBeNull();
    await waitFor(() => harness.events.some((event) => event.type === "branch.updated"));
    expect(existsSync(join(harness.config.worktreeDir, ownerCopyName))).toBe(false);
    expect(await harness.env.invocations()).toEqual([]);
  });

  it("folds a fixer's conflict resolution into the owner's commit", async () => {
    const harness = await ownerHarness({
      turns: [
        {
          match: { role: "branch-fixer", prompt: "Reword the heading" },
          steps: [
            { kind: "write", path: "README.md", content: "# Demo app project\n" },
            { kind: "bash", command: "git add README.md" },
            { kind: "text", text: "Kept both headings' words." },
          ],
        },
      ],
    });
    const { repo } = harness;
    await commit(repo, "README.md", "# Demo app\n", "--message", "Reword the heading");
    await commit(repo, "notes.txt", "notes\n", "--message", "Add notes");
    const before = await ownCommits(repo, "main..dev");
    await commitOnMain(repo, "README.md", "# Demo project\n", "main: retitle");
    const moved = await repo.git("rev-parse", "main");

    await harness.actions.invoke("rebaseOwnerBranch", { branch: "dev" });
    const rebase = await harness.finished();

    expect(rebase.status).toBe("succeeded");
    expect(rebase.outcome).toBe(
      "Rebased dev onto main: 2 commits of yours are on main now; a fixer resolved conflicts in one of them.",
    );
    expect(await repo.git("rev-list", "--count", `${moved}..main`)).toBe("2");
    expect(await ownCommits(repo, `${moved}..main`)).toBe(before);
    expect(await repo.git("show", "main~1:README.md")).toBe("# Demo app project");
    expect(await repo.git("diff", "--name-only", "main~2", "main~1")).toBe("README.md");
    expect(findAttribution(await repo.git("log", "--format=%B", "main"))).toEqual([]);
    expect(await repo.git("rev-parse", "dev")).toBe(await repo.git("rev-parse", "main"));

    const fixers = harness.db.sessions.list().filter((session) => session.role === "fixer");
    expect(fixers).toMatchObject([{ taskId: null, status: "succeeded" }]);
    expect(harness.errors).toEqual([]);
  });

  it("offers to rebase the branch when main moves, and rebases it once confirmed", async () => {
    const harness = await ownerHarness();
    const { repo } = harness;
    await commit(repo, "notes.txt", "notes\n", "--message", "Add notes");
    await commitOnMain(repo, "other.txt", "other\n", "main: other change");
    harness.bus.emit({
      type: "main.moved",
      branch: "main",
      commit: await repo.git("rev-parse", "main"),
    });

    const offer = await waitFor(() =>
      harness.db.chat.list().find((message) => message.kind === "proposal"),
    );
    expect(offer.content).toBe("main moved 1 commit; rebase dev onto it?");
    const [proposal] = harness.db.proposals.listPending();
    expect(proposal?.args).toEqual({ branch: "dev" });

    await harness.gate.confirm(proposal?.id ?? 0);
    const rebase = await harness.finished();

    expect(rebase.status).toBe("succeeded");
    expect(await repo.git("log", "-1", "--format=%s", "main")).toBe("Add notes");
    expect(await repo.git("rev-parse", "dev")).toBe(await repo.git("rev-parse", "main"));
    expect(harness.db.proposals.listPending()).toEqual([]);
    expect(harness.errors).toEqual([]);
  });
});
