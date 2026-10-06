import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resumePrompt, wipMessage } from "@mastermind/core/sessions";
import { describe, expect, it } from "vitest";
import { waitFor } from "../../support/processes.js";
import { owner } from "../../support/temp-repo.js";
import { pathGuardCommand, promptsDir, sessionHarness } from "./harness.js";

const forbiddenFlags = ["--bare", "--dangerously-skip-permissions", "--max-budget-usd"];

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

describe("worker sessions", () => {
  it("runs setup once in a new clone, then a worker that edits and commits brings its task to checking", async () => {
    const harness = await sessionHarness({
      scenario: {
        turns: [
          {
            steps: [
              { kind: "read", path: "src/app.ts" },
              { kind: "edit", path: "src/app.ts", oldString: "41", newString: "42" },
              { kind: "commit", message: "app: fix the answer" },
              { kind: "resultFile", content: "Fixed the answer.\n" },
              { kind: "text", text: "Done." },
            ],
          },
        ],
      },
      config: { commands: { setup: "echo installed dependencies", build: "", test: "" } },
    });
    const answer = harness.addTask("answer");

    await harness.manager.startTask(answer);
    const task = await harness.waitForStatus("answer", "checking");

    const [session] = harness.db.sessions.listForTask("answer");
    const head = await harness.cloneGit("answer", "rev-parse", "HEAD");
    expect(session).toMatchObject({
      status: "succeeded",
      attempt: 1,
      endCommit: head,
      inputTokens: 42 + 16_384 + 2_048,
      outputTokens: 128,
    });
    expect(await harness.cloneGit("answer", "log", "-1", "--format=%s")).toBe(
      "app: fix the answer",
    );
    expect(task).toMatchObject({
      attempts: 0,
      branch: "task/answer",
      worktree: join(harness.config.worktreeDir, "answer"),
    });
    expect(await harness.cloneGit("answer", "rev-parse", "HEAD~1")).toBe(task.baseCommit);
    expect(await harness.repo.git("rev-parse", "main")).toBe(task.baseCommit);

    const stored = harness.db.events.listForSession(session?.id ?? 0);
    expect(stored.map((event) => event.type)).toEqual([
      "start",
      "read",
      "edit",
      "run",
      "commit",
      "edit",
      "note",
      "result",
    ]);
    expect(stored.find((event) => event.type === "commit")?.summary).toContain(
      "app: fix the answer",
    );
    const broadcast = harness.events.filter((event) => event.type === "session.event");
    expect(broadcast.map((event) => event.event.id)).toEqual(stored.map((event) => event.id));

    const [setup] = harness.db.checks.listForTask("answer");
    expect(setup).toMatchObject({ kind: "setup", status: "passed" });
    expect(await readFile(setup?.logPath ?? "", "utf8")).toContain("installed dependencies");
    expect(harness.errors).toEqual([]);
  });

  it("commits uncommitted leftovers as a WIP commit with the owner's identity and no trailers", async () => {
    const harness = await sessionHarness({
      scenario: {
        turns: [
          {
            steps: [
              { kind: "write", path: "src/half-done.ts", content: "export const todo = true;\n" },
              { kind: "resultFile", content: "Ran out of steam.\n" },
              { kind: "text", text: "Stopping here." },
            ],
          },
        ],
      },
    });
    const task = harness.addTask("leftovers");

    await harness.manager.startTask(task);
    await harness.waitForStatus("leftovers", "checking");

    const commit = await harness.cloneGit("leftovers", "log", "-1", "--format=%an <%ae>%n%B");
    expect(commit).toBe(`${owner.name} <${owner.email}>\n${wipMessage}`);
    expect(await harness.cloneGit("leftovers", "log", "-1", "--format=%(trailers)")).toBe("");
    expect(await harness.cloneGit("leftovers", "status", "--porcelain")).toBe("");
    expect(await harness.cloneGit("leftovers", "ls-files")).not.toContain(".mastermind-result.md");
    const [session] = harness.db.sessions.listForTask("leftovers");
    expect(session?.endCommit).toBe(await harness.cloneGit("leftovers", "rev-parse", "HEAD"));
  });

  it.each([
    { workerPermissions: "bypass", permissionArgs: ["--permission-mode", "bypassPermissions"] },
    { workerPermissions: "auto", permissionArgs: ["--permission-mode", "auto"] },
    {
      workerPermissions: "allowlist",
      permissionArgs: [
        "--allowedTools",
        "Bash(git *)",
        "Bash(make *)",
        "--permission-mode",
        "acceptEdits",
      ],
    },
  ] as const)(
    "spawns a $workerPermissions worker with the 8.3 flags and settings, in its clone, with a cleaned env",
    async ({ workerPermissions, permissionArgs }) => {
      const harness = await sessionHarness({
        scenario: { turns: [{ steps: [{ kind: "text", text: "Done." }] }] },
        config: {
          workerPermissions,
          sandbox: {
            enabled: true,
            allowedDomains: ["registry.npmjs.org"],
            allowWrite: ["~/.npm"],
          },
        },
      });
      const task = harness.addTask("flags");

      await harness.manager.startTask(task);
      const { worktree } = await harness.waitForStatus("flags", "checking");

      const [invocation] = await harness.env.invocations();
      const [session] = harness.db.sessions.listForTask("flags");
      if (invocation === undefined || session === undefined) throw new Error("no worker ran");
      const { argv } = invocation;
      expect(argv.slice(0, 1)).toEqual(["-p"]);
      expect(argv.join(" ")).toContain(permissionArgs.join(" "));
      expect({
        sessionId: flagValue(argv, "--session-id"),
        model: flagValue(argv, "--model"),
        input: flagValue(argv, "--input-format"),
        output: flagValue(argv, "--output-format"),
        prompts: flagValue(argv, "--permission-prompts"),
        systemPrompt: flagValue(argv, "--append-system-prompt-file"),
      }).toEqual({
        sessionId: session.claudeSessionId,
        model: "opus",
        input: "stream-json",
        output: "stream-json",
        prompts: "none",
        systemPrompt: join(promptsDir, "worker.md"),
      });
      expect(argv).toEqual(
        expect.arrayContaining(["--verbose", "--strict-mcp-config", "--replay-user-messages"]),
      );
      expect(argv.filter((arg) => forbiddenFlags.includes(arg))).toEqual([]);
      expect(invocation.unknownFlags).toEqual([]);

      expect(JSON.parse(flagValue(argv, "--settings") ?? "null")).toEqual({
        attribution: { commit: "", pr: "", sessionUrl: false },
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          failIfUnavailable: true,
          network: { allowedDomains: ["registry.npmjs.org"], strictAllowlist: true },
          filesystem: { allowWrite: [join(harness.env.home, ".npm")] },
        },
        permissions: {
          deny: [
            `Edit(/${harness.repo.path}/**)`,
            `Write(/${harness.repo.path}/**)`,
            `Edit(/${harness.env.home}/.claude/**)`,
            `Write(/${harness.env.home}/.claude/**)`,
          ],
        },
        hooks: {
          PreToolUse: [
            {
              matcher: "Edit|Write|MultiEdit|NotebookEdit",
              hooks: [
                {
                  type: "command",
                  command: [...pathGuardCommand, worktree].map((arg) => `'${arg ?? ""}'`).join(" "),
                },
              ],
            },
          ],
        },
      });

      expect(invocation.cwd).toBe(worktree);
      expect(invocation.pgid).toBe(invocation.pid);
      expect(Object.keys(invocation.env).sort()).toEqual(["CLAUDE_CONFIG_DIR", "HOME"]);
      const [message] = (await harness.env.readLog()).filter((record) => record.kind === "message");
      expect(message?.text).toContain("# Task flags: Build flags");
      expect(message?.text).toContain("make test");
      expect(message?.text).toContain("- src/");
    },
  );

  it("sends a usage-limited task back to pending with a back-off and no attempt, then resumes its session", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;
    const harness = await sessionHarness({
      scenario: {
        turns: [
          { match: { flags: ["--resume"] }, steps: [{ kind: "text", text: "Picked it up." }] },
          {
            steps: [
              { kind: "write", path: "src/partial.ts", content: "export {};\n" },
              { kind: "usageLimit", resetsAt },
            ],
          },
        ],
      },
    });
    const task = harness.addTask("limited");

    await harness.manager.startTask(task);
    await waitFor(() => harness.db.sessions.listForTask("limited")[0]?.status === "rate_limited");

    const [limited] = harness.db.sessions.listForTask("limited");
    const requeued = harness.db.tasks.get("limited");
    expect(requeued).toMatchObject({
      status: "pending",
      attempts: 0,
      resumeSession: limited?.claudeSessionId,
    });
    expect(harness.db.flags.get().backoffResumeAt).toBe(new Date(resetsAt * 1000).toISOString());

    await harness.manager.startTask(requeued ?? task);
    await harness.waitForStatus("limited", "checking");

    const [, resumed] = await harness.env.invocations();
    expect(flagValue(resumed?.argv ?? [], "--resume")).toBe(limited?.claudeSessionId);
    expect(resumed?.argv).not.toContain("--session-id");
    const messages = (await harness.env.readLog()).filter((record) => record.kind === "message");
    expect(messages.at(-1)?.text).toBe(resumePrompt);
    expect(harness.db.sessions.listForTask("limited").map((session) => session.attempt)).toEqual([
      1, 1,
    ]);
    expect(harness.db.tasks.get("limited")).toMatchObject({ attempts: 0, resumeSession: null });
  });

  it("sets authRequired and pauses when the sign-in has expired, without counting an attempt", async () => {
    const harness = await sessionHarness({
      scenario: { turns: [{ steps: [{ kind: "authExpired" }] }] },
    });
    const task = harness.addTask("signed-out");

    await harness.manager.startTask(task);
    await waitFor(() => harness.db.flags.get().authRequired);

    expect(harness.db.flags.get()).toMatchObject({ authRequired: true, paused: true });
    expect(harness.db.tasks.get("signed-out")).toMatchObject({
      status: "pending",
      attempts: 0,
      resumeSession: null,
    });
    expect(harness.db.sessions.listForTask("signed-out")[0]?.status).toBe("auth_failed");
    expect(harness.events).toContainEqual({ type: "auth.updated", authRequired: true });
  });

  it("stops a session with SIGTERM and holds its task for resuming", async () => {
    const harness = await sessionHarness({
      scenario: {
        turns: [
          {
            steps: [
              { kind: "write", path: "src/wip.ts", content: "export {};\n" },
              { kind: "hang" },
            ],
          },
        ],
      },
    });
    const task = harness.addTask("stoppable");
    await harness.manager.startTask(task);
    const session = await waitFor(() => {
      const [running] = harness.db.sessions.listForTask("stoppable");
      return (
        running !== undefined && harness.db.events.listForSession(running.id).length > 1 && running
      );
    });

    await harness.manager.stopSession(session.id);

    expect(harness.db.sessions.get(session.id)?.status).toBe("stopped");
    expect(harness.db.tasks.get("stoppable")).toMatchObject({
      status: "pending",
      held: true,
      attempts: 0,
      resumeSession: session.claudeSessionId,
    });
    const signals = (await harness.env.readLog()).filter((record) => record.kind === "signal");
    expect(signals).toEqual([expect.objectContaining({ signal: "SIGTERM", ignored: false })]);
    await expect(harness.manager.stopSession(session.id)).rejects.toThrow(/no running session/);
  });
});
