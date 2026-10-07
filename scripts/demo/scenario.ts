import type { Scenario, Step } from "../../test/support/fake-claude.js";

export const demoProject = "acme-api";

export const demoGoal = "Add a /health endpoint with a test, and document it in the README.";

export const demoRepoFiles: Record<string, string> = {
  "README.md": "# acme-api\n\nA tiny HTTP API.\n\n## Run\n\n    node src/server.js\n",
  Makefile: "build:\n\tnode --check src/server.js\n\ntest:\n\tnode --test\n",
  "mastermind.yaml": "requireReviewFor: [src/]\n",
  "src/server.js": [
    'import { createServer } from "node:http";',
    "",
    "const routes = {",
    '  "/": () => ({ name: "acme-api" }),',
    "};",
    "",
    "createServer((request, response) => {",
    "  const route = routes[request.url];",
    '  response.writeHead(route ? 200 : 404, { "content-type": "application/json" });',
    '  response.end(JSON.stringify(route ? route() : { error: "not found" }));',
    "}).listen(3000);",
    "",
  ].join("\n"),
};

const healthModule = [
  "export function health() {",
  '  return { status: "ok", uptimeSeconds: Math.round(process.uptime()) };',
  "}",
  "",
].join("\n");

const healthTest = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { health } from "../src/health.js";',
  "",
  'test("reports ok", () => {',
  '  assert.equal(health().status, "ok");',
  "});",
  "",
].join("\n");

const plan = [
  {
    id: "health",
    title: "Add the /health endpoint",
    goal: "Serve GET /health from src/server.js, backed by a health() module.",
    acceptance: "make build",
    touches: ["src/"],
    deps: [],
    note: "starts right away",
  },
  {
    id: "docs",
    title: "Document /health in the README",
    goal: "Add an Endpoints section to README.md that describes GET /health.",
    acceptance: "grep -q /health README.md",
    touches: ["README.md"],
    deps: [],
    note: "starts right away",
  },
  {
    id: "test",
    title: "Test the health check",
    goal: "Add test/health.test.js that checks health() reports ok.",
    acceptance: "make test",
    touches: ["test/"],
    deps: ["health"],
    note: "after health",
  },
];

const pause = (ms: number): Step => ({ kind: "sleep", ms });

function workerTurn(taskId: string, steps: Step[]): Scenario["turns"][number] {
  return { match: { role: "worker", prompt: `# Task ${taskId}:` }, steps };
}

export const demoScenario: Scenario = {
  turns: [
    {
      match: { role: "conductor", prompt: "/health endpoint" },
      steps: [
        { kind: "mcp", tool: "propose_plan", arguments: { tasks: plan } },
        {
          kind: "text",
          text: "Here's a plan in three tasks. **health** and **docs** run in parallel, and **test** starts once **health** lands. Press Start when it looks right.",
          streamMs: 70,
        },
      ],
    },
    workerTurn("health", [
      { kind: "read", path: "src/server.js" },
      pause(1500),
      { kind: "write", path: "src/health.js", content: healthModule },
      pause(1500),
      {
        kind: "edit",
        path: "src/server.js",
        oldString: 'import { createServer } from "node:http";',
        newString:
          'import { createServer } from "node:http";\nimport { health } from "./health.js";',
      },
      pause(800),
      {
        kind: "edit",
        path: "src/server.js",
        oldString: '  "/": () => ({ name: "acme-api" }),',
        newString: '  "/": () => ({ name: "acme-api" }),\n  "/health": health,',
      },
      pause(1200),
      { kind: "bash", command: "make build", description: "Check the server parses" },
      pause(1000),
      { kind: "commit", message: "Serve GET /health" },
      { kind: "text", text: "GET /health now returns the status and uptime." },
    ]),
    workerTurn("docs", [
      { kind: "read", path: "README.md" },
      pause(2000),
      {
        kind: "edit",
        path: "README.md",
        oldString: "## Run\n",
        newString:
          "## Endpoints\n\n- `GET /` returns the service name.\n- `GET /health` returns `{ status, uptimeSeconds }`.\n\n## Run\n",
      },
      pause(1500),
      { kind: "commit", message: "Document the /health endpoint" },
      { kind: "text", text: "The README lists both endpoints." },
    ]),
    workerTurn("test", [
      { kind: "read", path: "src/health.js" },
      pause(800),
      { kind: "write", path: "test/health.test.js", content: healthTest },
      pause(800),
      { kind: "bash", command: "make test", description: "Run the tests" },
      { kind: "commit", message: "Test that health() reports ok" },
      { kind: "text", text: "Added a passing test." },
    ]),
    {
      match: { role: "reviewer", prompt: "process.uptime()" },
      steps: [
        {
          kind: "structuredOutput",
          output: {
            findings: [
              {
                file: "src/health.js",
                line: 2,
                text: "Consider adding the app version so deploys are easy to confirm.",
                severity: "minor",
              },
            ],
          },
        },
      ],
    },
    {
      match: { role: "reviewer" },
      steps: [{ kind: "structuredOutput", output: { findings: [] } }],
    },
  ],
};
