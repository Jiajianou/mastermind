import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { claudeSamplesDir } from "../../support/fake-claude.js";
import type { Scenario } from "../../support/fake-claude.js";
import { isolatedEnv } from "../../support/isolated-env.js";
import type { IsolatedEnv } from "../../support/isolated-env.js";
import {
  findPids,
  isAlive,
  killProcessTree,
  trackChild,
  waitFor,
} from "../../support/processes.js";
import { createTempRepo, owner } from "../../support/temp-repo.js";
import { LineKinds, readJsonLines, SampleShapes } from "./stream-shapes.js";

const streamFlags = ["-p", "--output-format", "stream-json", "--verbose", "--model", "haiku"];
const streamInputFlags = [
  ...streamFlags,
  "--input-format",
  "stream-json",
  "--replay-user-messages",
];

const resultSchema = z.looseObject({
  type: z.literal("result"),
  is_error: z.boolean(),
  result: z.string().optional(),
  api_error_status: z.number().nullable().optional(),
  structured_output: z.unknown().optional(),
});
const syntheticSchema = z.looseObject({
  type: z.literal("assistant"),
  error: z.string(),
  message: z.looseObject({ content: z.tuple([z.looseObject({ text: z.string() })]) }),
});
const replaySchema = z.looseObject({
  isReplay: z.literal(true),
  message: z.looseObject({ content: z.string() }),
});
const rateLimitSchema = z.looseObject({
  type: z.literal("rate_limit_event"),
  rate_limit_info: z.looseObject({ status: z.string(), resetsAt: z.number() }),
});

interface FakeRun {
  pid: number;
  stdout(): string;
  lines(): unknown[];
  send(message: object): void;
  endInput(): void;
  exited: Promise<number | null>;
}

function startFake(env: IsolatedEnv, args: readonly string[], cwd: string): FakeRun {
  const child = spawn("claude", args, { cwd, env: env.env, detached: true });
  trackChild(child);
  if (child.pid === undefined) throw new Error("fake-claude did not start");
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  return {
    pid: child.pid,
    stdout: () => stdout,
    lines: () =>
      stdout
        .split("\n")
        .slice(0, -1)
        .map((line): unknown => JSON.parse(line)),
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    endInput: () => child.stdin.end(),
    exited,
  };
}

async function runWithPrompt(
  env: IsolatedEnv,
  args: readonly string[],
  cwd: string,
  prompt: string,
): Promise<{ lines: unknown[]; exitCode: number | null }> {
  const run = startFake(env, [...args, "--", prompt], cwd);
  run.endInput();
  const exitCode = await run.exited;
  return { lines: run.lines(), exitCode };
}

function userMessage(text: string): object {
  return { type: "user", message: { role: "user", content: text } };
}

const rpcRequestSchema = z.object({
  id: z.number().optional(),
  method: z.string(),
  params: z.looseObject({ name: z.string().optional() }).optional(),
});
type RpcRequest = z.infer<typeof rpcRequestSchema>;

function rpcAnswer(request: RpcRequest): object {
  switch (request.method) {
    case "initialize":
      return {
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "test-mastermind", version: "1.0.0" },
        },
      };
    case "tools/list":
      return { result: { tools: [{ name: "get_summary", inputSchema: { type: "object" } }] } };
    case "tools/call":
      return request.params?.name === "get_summary"
        ? { result: { content: [{ type: "text", text: "3 tasks, secret KUMQUAT" }] } }
        : { error: { code: -32602, message: "Unknown tool" } };
    default:
      return { error: { code: -32601, message: `Unknown method ${request.method}` } };
  }
}

async function startMcpServer(token: string): Promise<{ url: string; calls: RpcRequest[] }> {
  const calls: RpcRequest[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end();
        return;
      }
      const request = rpcRequestSchema.parse(JSON.parse(body));
      calls.push(request);
      if (request.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const answer = { jsonrpc: "2.0", id: request.id, ...rpcAnswer(request) };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  );
  const { port } = z.object({ port: z.number() }).parse(server.address());
  return { url: `http://127.0.0.1:${String(port)}/mcp`, calls };
}

const ofType = <T>(schema: z.ZodType<T>, lines: readonly unknown[]): T[] =>
  lines.flatMap((line) => {
    const parsed = schema.safeParse(line);
    return parsed.success ? [parsed.data] : [];
  });

describe("fake-claude", () => {
  it("emits stream-json lines shaped like the recorded samples of the real CLI", async () => {
    const env = await isolatedEnv();
    const repo = await createTempRepo({ files: { "hello.py": 'greeting = "hello"\n' } });
    await env.writeScenario({
      turns: [
        {
          match: { prompt: "work" },
          steps: [
            { kind: "read", path: "hello.py" },
            { kind: "edit", path: "hello.py", oldString: "hello", newString: "goodbye" },
            { kind: "write", path: "notes.txt", content: "notes\n" },
            { kind: "bash", command: "cat hello.py", description: "Show the file" },
            { kind: "bash", command: "echo broken >&2; exit 3" },
            { kind: "commit", message: "Say goodbye" },
            { kind: "resultFile", content: "Changed the greeting.\n" },
            { kind: "text", text: "Changed the greeting and committed it." },
          ],
        },
        {
          match: { flags: ["--json-schema"] },
          steps: [{ kind: "structuredOutput", output: { flaky: true, reason: "network" } }],
        },
        {
          match: { prompt: "steer me" },
          steps: [
            { kind: "text", text: "Working on it." },
            {
              kind: "awaitMessage",
              branches: [{ when: "BANANA", steps: [{ kind: "text", text: "Ends with BANANA" }] }],
            },
          ],
        },
        { match: { prompt: "hang" }, steps: [{ kind: "hang" }] },
        { match: { prompt: "expire" }, steps: [{ kind: "authExpired" }] },
        { match: { prompt: "limit" }, steps: [{ kind: "usageLimit" }] },
      ],
    });

    const partial = [...streamFlags, "--include-partial-messages"];
    const schema = '{"type":"object","properties":{"flaky":{"type":"boolean"}}}';
    const oneShots = await Promise.all([
      runWithPrompt(env, partial, repo.path, "work"),
      runWithPrompt(env, [...streamFlags, "--json-schema", schema], repo.path, "judge"),
      runWithPrompt(env, streamFlags, repo.path, "expire"),
      runWithPrompt(env, streamFlags, repo.path, "limit"),
    ]);

    const live = startFake(env, streamInputFlags, repo.path);
    live.send(userMessage("steer me"));
    await waitFor(() =>
      live.lines().some((line) => JSON.stringify(line).includes("Working on it")),
    );
    live.send(userMessage("End with BANANA"));
    await waitFor(() => ofType(resultSchema, live.lines()).length === 1);
    live.send(userMessage("hang"));
    await waitFor(() =>
      ofType(replaySchema, live.lines()).some((line) => line.message.content === "hang"),
    );
    live.send({ type: "control_request", request_id: "req-1", request: { subtype: "interrupt" } });
    await waitFor(() => ofType(resultSchema, live.lines()).length === 2);
    live.endInput();

    expect(await live.exited).toBe(0);
    expect(oneShots.map((run) => run.exitCode)).toEqual([0, 0, 1, 1]);
    const results = ofType(resultSchema, live.lines());
    expect(results.map((result) => [result.is_error, result.result])).toEqual([
      [false, "Ends with BANANA"],
      [true, undefined],
    ]);
    expect(ofType(resultSchema, oneShots[1].lines)[0]?.structured_output).toEqual({
      flaky: true,
      reason: "network",
    });

    const emitted = [...oneShots.flatMap((run) => run.lines), ...live.lines()];
    expect(SampleShapes.fromDirectory(claudeSamplesDir).problemsWith(emitted)).toEqual([]);
  });

  it.each([
    { trailer: true, expected: ["Claude Haiku 4.5 <noreply@anthropic.com>"] },
    { trailer: undefined, expected: [] },
  ] as const)(
    "commits as the owner with trailer $trailer and reports the commit",
    async ({ trailer, expected }) => {
      const env = await isolatedEnv();
      const repo = await createTempRepo();
      const scenario: Scenario = {
        turns: [
          {
            steps: [
              { kind: "write", path: "a.txt", content: "a\n" },
              { kind: "commit", message: "Add a", trailer },
            ],
          },
        ],
      };
      await env.writeScenario(scenario);

      const run = await runWithPrompt(env, streamFlags, repo.path, "commit it");

      expect(run.exitCode).toBe(0);
      const trailers = await repo.git(
        "log",
        "-1",
        "--format=%(trailers:key=Co-Authored-By,valueonly)",
      );
      expect(trailers.split("\n").filter((line) => line !== "")).toEqual(expected);
      expect(await repo.git("log", "-1", "--format=%s|%an <%ae>")).toBe(
        `Add a|${owner.name} <${owner.email}>`,
      );
      expect(run.lines).toContainEqual(
        expect.objectContaining({ subtype: "vcs_state_changed", kind: "commit", branch: "main" }),
      );
    },
  );

  it.each([
    { name: "auth expired", account: "max", prompt: "expire", sample: "04-auth-invalid-token" },
    { name: "signed out", account: "signed-out", prompt: "any", sample: "04-auth-not-logged-in" },
  ] as const)(
    "reproduces the recorded $name output and exits 1",
    async ({ account, prompt, sample }) => {
      const env = await isolatedEnv({ account });
      await env.writeScenario({
        turns: [{ match: { prompt: "expire" }, steps: [{ kind: "authExpired" }] }],
      });
      const recorded = readJsonLines(join(claudeSamplesDir, `${sample}.jsonl`));

      const run = await runWithPrompt(env, streamFlags, env.root, prompt);

      const fakeKinds = new LineKinds();
      const recordedKinds = new LineKinds();
      expect(run.exitCode).toBe(1);
      expect(run.lines.map((line) => fakeKinds.kindOf(line))).toEqual(
        recorded.map((line) => recordedKinds.kindOf(line)),
      );
      const pick = (lines: unknown[]): unknown[] => [
        ...ofType(syntheticSchema, lines).map((line) => [line.error, line.message.content[0].text]),
        ...ofType(resultSchema, lines).map((line) => [
          line.is_error,
          line.api_error_status,
          line.result,
        ]),
      ];
      expect(pick(run.lines)).toEqual(pick(recorded));
    },
  );

  it("stops at a usage limit with a rejected rate limit, a 429 and the CLI's limit text", async () => {
    const env = await isolatedEnv();
    const resetsAt = 1791277800;
    await env.writeScenario({ turns: [{ steps: [{ kind: "usageLimit", resetsAt }] }] });

    const run = await runWithPrompt(env, streamFlags, env.root, "work");

    expect(run.exitCode).toBe(1);
    expect(ofType(rateLimitSchema, run.lines).at(-1)?.rate_limit_info).toMatchObject({
      status: "rejected",
      resetsAt,
    });
    expect(ofType(syntheticSchema, run.lines)[0]?.error).toBe("rate_limit");
    const result = ofType(resultSchema, run.lines)[0];
    expect(result).toMatchObject({ is_error: true, api_error_status: 429 });
    expect(result?.result).toMatch(/^You've hit your limit · resets /);
    expect(result?.result).toMatch(
      /usage limit|hit your (?:\w+ )?limit|weekly (?:usage )?limit|out of extra usage|spend limit/i,
    );
  });

  it("calls tools on the --mcp-config server with its headers, reporting failures as tool errors", async () => {
    const env = await isolatedEnv();
    const mcp = await startMcpServer("secret-token");
    const config = JSON.stringify({
      mcpServers: {
        mastermind: {
          type: "http",
          url: mcp.url,
          headers: { Authorization: "Bearer secret-token" },
        },
      },
    });
    await env.writeScenario({
      turns: [
        {
          match: { prompt: "summary" },
          steps: [{ kind: "mcp", tool: "get_summary", arguments: { verbose: true } }],
        },
        { match: { prompt: "explode" }, steps: [{ kind: "mcp", tool: "explode" }] },
      ],
    });
    const args = [...streamFlags, "--mcp-config", config, "--strict-mcp-config"];

    const [summary, explode] = await Promise.all([
      runWithPrompt(env, args, env.root, "summary"),
      runWithPrompt(env, args, env.root, "explode"),
    ]);

    expect([summary.exitCode, explode.exitCode]).toEqual([0, 0]);
    expect(summary.lines[0]).toMatchObject({
      mcp_servers: [{ name: "mastermind", status: "connected" }],
      tools: expect.arrayContaining(["mcp__mastermind__get_summary"]) as unknown,
    });
    const toolResults = (lines: unknown[]): unknown[] =>
      lines.filter((line) => JSON.stringify(line).includes('"tool_result"'));
    expect(toolResults(summary.lines)).toEqual([
      expect.objectContaining({
        tool_use_result: [{ type: "text", text: "3 tasks, secret KUMQUAT" }],
      }),
    ]);
    expect(toolResults(explode.lines)).toEqual([
      expect.objectContaining({
        message: { role: "user", content: [expect.objectContaining({ is_error: true })] },
      }),
    ]);
    expect(mcp.calls).toContainEqual(
      expect.objectContaining({
        method: "tools/call",
        params: { name: "get_summary", arguments: { verbose: true } },
      }),
    );
    expect(SampleShapes.fromDirectory(claudeSamplesDir).problemsWith(summary.lines)).toEqual([]);
  });

  it("reports auth status like the recorded samples and follows login and logout", async () => {
    const env = await isolatedEnv();
    const status = async (): Promise<{ exitCode: number | null; json: unknown }> => {
      const run = startFake(env, ["auth", "status", "--json"], env.root);
      run.endInput();
      const exitCode = await run.exited;
      const json: unknown = JSON.parse(run.stdout());
      return { exitCode, json };
    };
    const login = async (extraEnv: Record<string, string>): Promise<number | null> => {
      const child = spawn("claude", ["auth", "login", "--claudeai"], {
        cwd: env.root,
        env: { ...env.env, ...extraEnv },
        detached: true,
        stdio: "ignore",
      });
      trackChild(child);
      return new Promise((resolve) => child.on("close", resolve));
    };
    const recorded = (name: string): unknown => {
      const sample = z
        .record(z.string(), z.unknown())
        .parse(
          JSON.parse(readFileSync(join(claudeSamplesDir, `04-auth-status-${name}.json`), "utf8")),
        );
      return {
        ...sample,
        projectsDirectory: env.home + "/.claude/projects",
        configDirectory: env.home + "/.claude",
      };
    };

    expect(await status()).toEqual({ exitCode: 0, json: recorded("signed-in") });

    const logout = startFake(env, ["auth", "logout"], env.root);
    logout.endInput();
    expect(await logout.exited).toBe(0);
    expect(await status()).toEqual({ exitCode: 1, json: recorded("logged-out") });

    expect(await login({ FAKE_CLAUDE_LOGIN_FAIL: "1" })).toBe(1);
    expect((await status()).exitCode).toBe(1);
    expect(await login({ FAKE_CLAUDE_LOGIN_ACCOUNT: "pro" })).toBe(0);
    expect((await status()).json).toMatchObject({ loggedIn: true, subscriptionType: "pro" });
  });

  it("logs every invocation with its argv, unknown flags, selected env, pid and pgid", async () => {
    const env = await isolatedEnv({ env: { CLAUDECODE: "1", ANTHROPIC_API_KEY: "sk-test" } });
    const args = [...streamFlags, "--brand-new-flag", "--session-id", crypto.randomUUID()];

    const run = startFake(env, [...args, "--", "hi"], env.root);
    run.endInput();
    expect(await run.exited).toBe(0);

    const [invocation] = await env.invocations();
    expect(invocation).toMatchObject({
      argv: [...args, "--", "hi"],
      unknownFlags: ["--brand-new-flag"],
      cwd: env.root,
      pid: run.pid,
      pgid: run.pid,
      env: { CLAUDECODE: "1", ANTHROPIC_API_KEY: "sk-test", HOME: env.home },
    });
    expect(await env.readLog()).toContainEqual(
      expect.objectContaining({ kind: "message", text: "hi" }),
    );
  });

  it.each([
    { group: "the fake's own group", sameGroup: true },
    { group: "a group of its own, like a Bash tool", sameGroup: false },
  ])(
    "leaves nothing behind when a hung fake with a grandchild in $group is killed by group",
    async ({ sameGroup }) => {
      const env = await isolatedEnv();
      const marker = `grandchild-${crypto.randomUUID()}`;
      await env.writeScenario({
        turns: [
          {
            steps: [
              { kind: "spawnGrandchild", marker, sameGroup },
              { kind: "hang", ignoreSigterm: true },
            ],
          },
        ],
      });

      const run = startFake(env, [...streamFlags, "--", "hang"], env.root);
      run.endInput();
      const grandchild = await waitFor(() => findPids(marker)[0]);
      process.kill(-run.pid, "SIGTERM");
      await waitFor(async () =>
        (await env.readLog()).some((record) => record.kind === "signal" && record.ignored),
      );
      expect(env.livePids()).toContain(run.pid);

      if (sameGroup) process.kill(-run.pid, "SIGKILL");
      else killProcessTree([run.pid]);

      await waitFor(() => findPids(marker).length === 0 && env.livePids().length === 0);
      expect(isAlive(grandchild)).toBe(false);
      expect(await run.exited).toBeNull();
    },
  );
});
