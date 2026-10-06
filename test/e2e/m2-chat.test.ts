import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../support/isolated-env.js";
import { conductorToolCalls, openProjectDb, startMastermind } from "../support/mastermind.js";
import { waitFor } from "../support/processes.js";
import { createTempRepo } from "../support/temp-repo.js";

describe("milestone 2: chatting with mastermind from the terminal", () => {
  it("adds a task by chat, a worker picks it up, and the status answer reflects that", async () => {
    const repo = await createTempRepo({ files: { "README.md": "# Demo\n" } });
    await repo.git("switch", "--quiet", "--create", "dev");
    const env = await isolatedEnv();
    await env.writeScenario({
      turns: [
        {
          match: { role: "conductor", prompt: "add a task" },
          steps: [
            {
              kind: "mcp",
              tool: "create_tasks",
              arguments: {
                tasks: [
                  {
                    id: "hello",
                    title: "Create hello.txt",
                    goal: "Add hello.txt with a greeting.",
                    acceptance: "test -f hello.txt",
                    touches: ["hello.txt"],
                  },
                ],
              },
            },
            { kind: "text", text: "I added hello." },
          ],
        },
        {
          match: {
            role: "conductor",
            prompt: { pattern: "Running: hello \\(worker, attempt 1, [\\s\\S]*what's running\\?$" },
          },
          steps: [
            { kind: "mcp", tool: "list_sessions" },
            { kind: "text", text: "A worker is on hello." },
          ],
        },
        { match: { role: "conductor" }, steps: [{ kind: "text", text: "Nothing is running." }] },
        {
          match: { role: "worker" },
          steps: [{ kind: "text", text: "Creating hello.txt" }, { kind: "hang" }],
        },
      ],
    });
    const running = await startMastermind(repo, env.env);
    const db = openProjectDb(repo);

    const added = await running.run(["chat", "add a task to create hello.txt"]);
    expect(added).toMatchObject({
      code: 0,
      stderr: "",
      stdout: "I added hello.\n✓ Added 1 task\n",
    });
    expect(db.tasks.get("hello")).toMatchObject({ title: "Create hello.txt" });

    await waitFor(
      () =>
        db.sessions
          .listForTask("hello")
          .some(
            (session) =>
              session.role === "worker" &&
              session.status === "running" &&
              db.events
                .listForSession(session.id)
                .some((event) => event.summary === "Creating hello.txt"),
          ),
      15_000,
    );

    const status = await running.run(["chat", "what's running?"]);
    expect(status).toMatchObject({ code: 0, stderr: "", stdout: "A worker is on hello.\n" });

    expect(conductorToolCalls(db)).toEqual([
      "mcp__mastermind__create_tasks",
      "mcp__mastermind__list_sessions",
    ]);
    const conductorRuns = (await env.invocations()).filter((invocation) =>
      invocation.argv.some((arg) => arg.endsWith("conductor.md")),
    );
    expect(conductorRuns).toHaveLength(1);
  });
});
