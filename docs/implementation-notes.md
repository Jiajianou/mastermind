# Implementation notes

Decisions and deviations recorded by each task of `./implement.sh`, so that later sessions can see why the code
looks the way it does. Each task adds a section under its own heading; `docs/PLAN.md` stays the source of truth for
the design, and these notes only explain where and why the implementation chose a detail the plan left open or
departed from it.

## m0-scaffold

- **pnpm 12 build approvals.** pnpm 12 no longer reads the `pnpm` field in package.json and warns about it, so
  `pnpm.onlyBuiltDependencies` would have no effect. The equivalent setting is `allowBuilds` in
  `pnpm-workspace.yaml`, which allows esbuild and node-pty. Add any later native or binary dependency there.
- **TypeScript 6.0, not 7.** typescript-eslint supports TypeScript `<6.1`, so the workspace pins `~6.0.3`.
  TypeScript 6 defaults `types` to `[]`, so the base config lists `node` explicitly and web uses `vite/client`.
- **`@types/node` 22** matches the lowest supported Node (22.13), so APIs only present in newer Node fail typecheck.
- **No package emits declarations.** Every tsconfig has `noEmit`; tsup bundles the CLI with `@mastermind/*`
  inlined and Vite builds web. Workspace packages export their TypeScript sources directly
  (`@mastermind/core/contracts` → `src/contracts/index.ts`). Core has no `.` export yet; add one when core gains
  Node-side modules.
- **Typecheck layout.** The root `tsconfig.json` covers tool configs (`*.config.ts`, including those inside
  packages) and everything under `test/`; each package's `tsconfig.json` covers its `src`. ESLint uses these
  projects through `parserOptions.project`. The root package depends on `@mastermind/core` (`workspace:*`) so that
  integration and e2e tests can import it; add other workspace packages there when tests need them.
- **Browser-safe contracts** are enforced twice: an ESLint `no-restricted-imports` rule bans Node built-ins in
  `packages/core/src/contracts/`, and web typechecks the contracts it imports without Node types.
- **The CLI reads its version** by importing its own package.json (inlined by tsup).
- **Vitest projects** live in the root `vitest.config.ts` with `passWithNoTests`. The web project extends
  `packages/web/vite.config.ts` for the React plugin. The `live` project only exists when `MASTERMIND_LIVE=1`,
  which `pnpm test:live` sets, so no other script can run live tests by accident. Live tests go in `test/live/`.
- **Playwright** runs with `--pass-with-no-tests`. `test:e2e` runs `playwright install chromium` first. On Linux
  CI, a separate workflow step installs the browser's system libraries, because that needs sudo and must not run
  from an everyday script.
- **Prettier** ignores Markdown, `tasks.yaml` and recorded CLI samples, so the plan, prompts and fixtures are never
  reflowed.

## m0-spikes

The full findings are in `docs/claude-cli-notes.md`, and the fixtures are in `test/fixtures/claude-samples/`. These
points change or sharpen PLAN.md, and later tasks must follow them:

- **Tool subprocesses escape `kill(-pgid)`.** Claude Code runs every Bash tool command in its own process group.
  So SIGKILL to a session's group orphans `make` and everything under it. The kill path snapshots the process
  tree (`ps -axo pid=,ppid=,pgid=`) and SIGKILLs every descendant group. Descendant pgids are also recorded in
  SQLite while a session runs, so the startup reaper can find them after a crash. A plain SIGTERM lets claude
  clean up after itself.
- **Mastermind needs its own path guard** (decision 9). Under `bypassPermissions` with the sandbox on, Edit and
  Write can still write anywhere a deny rule doesn't name. The guard is a `PreToolUse` hook passed in `--settings`.
- **ChatRunner** uses one persistent stream-json process. **Steering** is a stdin write acknowledged by
  `--replay-user-messages`.
- **Extra spawn flags** beyond PLAN 8.3 and 6.2:
  - `--strict-mcp-config` on every spawn, so the owner's claude.ai connectors aren't loaded
  - `--permission-prompts none` for workers and fixers
  - `--replay-user-messages` with stream-json input
  - prompts always sent on stdin, because variadic flags such as `--tools` swallow a positional prompt
- **`--permission-mode auto` can silently become `default`.** This happens with haiku, for example. Mastermind
  checks `init.permissionMode` against the requested mode and fails the session if they differ.
- **`claude auth status --json`** exits 1 when logged out (with JSON still on stdout). It reports
  `authMethod: "oauth_token"` without `subscriptionType` for `CLAUDE_CODE_OAUTH_TOKEN`, so the classifier refuses
  a token it can't show to be Pro or Max. A valid setup-token is untested.
- **Unrecognised failures** (non-zero exit, missing `result`, unclassified `is_error`) back off globally without
  counting an attempt. A per-task count of consecutive ones blocks the task after 3, so a deterministic CLI error
  can't retry forever. Runs that mastermind stopped itself are never classified as failures.
- **Owner user settings stay loaded** in sessions (no `--setting-sources`). The path guard and sandbox bound what
  their extra directories and allow rules could otherwise widen.
- **Nested-session variables** are removed from every child. `CLAUDE_CODE_MESSAGING_TOKEN` measurably changes a
  child's behaviour.
- **Linux sandbox behaviour (bubblewrap) is untested.** The spikes ran on macOS only.

## m0-fake-claude

- **Running it.** `test/fixtures/fake-claude/bin/claude` is a `sh` shim that `exec`s `node bin/run.js`, which
  registers tsx (`tsx/esm/api`) and imports `src/main.ts`. One process per invocation, so its pid and pgid are the
  ones mastermind spawned. `tsx` and `zod` are root dev dependencies. Startup is about 0.3 s. Tested on Node 22.13
  and 26.
- **Environment knobs** (all optional): `FAKE_CLAUDE_SCENARIO` (scenario JSON path; a missing file means "reply
  `Done.`"), `FAKE_CLAUDE_LOG` (JSONL log), `FAKE_CLAUDE_STATE` (state dir for auth and session ids),
  `FAKE_CLAUDE_VERSION` (default `2.1.283`), `FAKE_CLAUDE_ACCOUNT` (initial account, default `max`),
  `FAKE_CLAUDE_LOGIN_ACCOUNT` (account a login produces, default `max`) and `FAKE_CLAUDE_LOGIN_FAIL=1`.
- **Accounts.** `max pro team enterprise free signed-out oauth-token console api-key api-key-helper bedrock vertex`.
  Only `max`, signed out and `oauth-token` come from recorded samples. The others are plausible guesses (for example
  `authMethod: "console"`, `"api_key"` with `apiKeySource`, `"third_party"` with `apiProvider: "bedrock"`), shaped so
  that each fails PLAN 4.1 for its own reason. The fake also reports `bedrock`, `vertex` or `api-key` when
  `CLAUDE_CODE_USE_BEDROCK=1`, `CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` reach it,
  so an environment cleaner bug shows up in the auth gate. `CLAUDE_CODE_OAUTH_TOKEN` (which PLAN 4.4 keeps) makes it
  report `oauth-token`, as the real CLI does. A `-p` run while signed out prints the recorded "Not logged in" output.
- **Scenarios** (`src/scenario.ts`, typed and zod-validated; tests import `Scenario` from `test/support/fake-claude.ts`).
  `turns` is a list of `{ match?, steps }`. Every user message that starts a turn picks the first turn whose `match`
  fits: `role` (basename of `--append-system-prompt-file`, so `prompts/worker.md` is `worker`), `prompt` (substring,
  or `{ pattern }` regex) and `flags` (all must be in argv, for example `["--resume"]` or `["--json-schema"]`). No
  match exits 2 with `fake-claude: …` on stderr, as do invalid scenarios and steps that need a missing flag.
  Steps: `text`, `read`, `write`, `edit`, `bash`, `commit` (`trailer: true` adds
  `Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>`, or give the trailer text), `resultFile`,
  `structuredOutput` (needs `--json-schema`), `mcp`, `sleep`, `hang` (`ignoreSigterm`), `spawnGrandchild`
  (`marker`, `sameGroup`), `awaitMessage` (branches on the next stdin message), `usageLimit`, `authExpired`
  (`variant`, `signOut`) and `crash`.
- **Realism choices.** Bash and commit steps really run in cwd through `/bin/sh`, each in its own process group like
  Claude Code's Bash tool. SIGTERM kills those groups and exits 143; SIGINT exits 130. `--permission-mode auto`
  with a haiku model reports `permissionMode: "default"`, as in spike 7. Reusing a `--session-id` or resuming an
  unknown or non-UUID id fails like the real CLI (the "No conversation found" text is unverified). Stream-json input keeps the
  process alive across turns, replays messages with `--replay-user-messages`, delivers mid-turn messages at the next
  step boundary and answers `control_request` interrupts with the recorded interrupt lines. Unknown flags are
  logged in `unknownFlags`, never fatal.
- **Usage-limit output is synthesised**, because no real one was recorded: a `rate_limit_event` with
  `status: "rejected"`, a synthetic assistant line with `error: "rate_limit"` and the text
  `You've hit your limit · resets <h>am|pm (UTC)`, then an error `result` with `api_error_status: 429`, exit 1.
- **MCP.** With `--mcp-config` (file or JSON), the fake runs `initialize`, `notifications/initialized` and
  `tools/list` against each HTTP server with its headers, reports `connected` or `failed` in `init.mcp_servers`
  and adds `mcp__<server>__<tool>` to `init.tools`. The `mcp` step calls `tools/call` and emits `tool_use_meta` (server name
  from `serverInfo`, tool title or title-cased name) as in sample 06. A JSON-RPC or HTTP failure of the call becomes
  an `is_error` tool result, not a crash of the fake. JSON and SSE responses are
  read. m2-conductor can extend `src/mcp.ts` and the step union.
- **Log records** (`FakeClaudeLogRecord`): `invocation` (argv, cwd, pid, ppid, pgid, unknown flags, env vars matching
  `ANTHROPIC_*`, `CLAUDE*`, `AI_AGENT`, `HOME`, `GIT_EDITOR`), `message` (every user message received), `spawn`
  (pid and pgid of every grandchild and Bash or commit step command) and `signal` (SIGTERM or SIGINT received, and whether it was ignored).
- **Contract test.** `test/integration/fake-claude/stream-shapes.ts` builds per-kind shapes from every recorded
  sample (kind = type, subtype, first block type and tool name, or stream event type). Each fake line must be of a
  recorded kind, have every key that all samples of that kind have, and have no key or JSON type the samples never
  show. Keep it passing when the fake changes; if a new real sample is recorded, the fake must follow.
- **Harness** (`test/support/`), wired into the integration and e2e projects:
  - `global-setup.ts` puts the fake first on `PATH` for the whole run and refuses to start if `claude` would resolve
    to anything else (for example if the shim lost its exec bit).
  - `setup.ts` runs registered cleanups in `afterEach`. `createTempRepo`, `isolatedEnv`, `makeTempDir` and
    `trackChild` register theirs, so call them inside a test or `beforeEach`, not `beforeAll`.
  - `isolatedEnv()` makes a temp root with `home/` (a `.gitconfig` with the owner identity, as on the owner's
    machine), `home/.mastermind/worktrees` (`worktreeRoot`) and `bin/` with symlinks to the shim and `run.js`. Every
    fake started from it shows `<root>/bin/run.js` in `ps`, which is the per-env marker `livePids()` and the cleanup
    use. The cleanup also kills every still-live group from the log's `spawn` records, because a Bash step's
    `/bin/sh` runs in its own group and outlives a SIGKILLed fake without carrying the marker. Its `env` drops inherited `ANTHROPIC_*`, `CLAUDE*`, `GIT_*`, `FAKE_CLAUDE_*` and `AI_AGENT`, then sets
    `HOME`, `PATH`, `CLAUDE_CONFIG_DIR` and the fake's knobs.
  - `processes.ts`: `processTable`, `findPids(marker)`, `isAlive`, `killProcessTree` (one `ps` snapshot, SIGKILL
    every descendant group, never the test's own group), `killMarkedProcesses` and `waitFor(condition, timeoutMs)`.
- **Timeouts.** The integration and e2e projects use 30 s test and hook timeouts, because each fake start costs
  about 0.3 s and later tests chain several.
