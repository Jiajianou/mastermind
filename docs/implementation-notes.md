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

## m1-config

- **Where it lives.** `@mastermind/core/contracts` (`src/contracts/config.ts`) holds the browser-safe shapes:
  `configSchema` (the full, defaulted `Config` that Settings edits), `configLayerSchema` (a deep-partial layer, as
  written in either YAML file or sent as a change), `parseDuration`, `resolveMaxWorkers`, `SubscriptionPlan` and the
  detection result `ProjectDetection`. The Node side is `@mastermind/core/config` (`src/config/`), a new package
  export.
- **Strict keys.** Every config object is a `z.strictObject`, so a typo such as `models.wroker` is an error that
  names the key instead of being ignored. `ConfigError` carries `file` and `issues: { key, message }[]`, and its
  message reads `.mastermind/config.yaml: stuckCheck.after: expected a duration such as 60m, 90s or 1h30m`.
  Changes passed to `setConfig` are reported as `config change: <key>: …`.
- **Layering** validates each file as a layer first (so errors name the file), then deep-merges defaults ←
  `mastermind.yaml` ← `.mastermind/config.yaml`. Objects merge key by key; arrays and scalars replace.
- **`setConfig(context, overrides)`** validates the change, edits `.mastermind/config.yaml` as a YAML `Document`
  (comments, order and unrelated keys survive), sets only the leaves present in the change, validates the result
  and writes it atomically (temp file plus rename). It returns the merged config. There is no "unset" yet.
  Calls are serialised per file within the process, so concurrent changes from Settings and the Conductor
  are all kept. The `@mastermind/core/config` barrel exports only the public API; setup helpers stay private.
- **`Config` keeps the file form** (`maxWorkers: auto`, durations as text, `~/` paths), so it round-trips through
  Settings. `resolveConfig(config, { repoRoot, homeDir, plan })` gives the runtime form: `maxWorkers` as a number
  (auto = 1 on Pro, 2 on Max), `stuckCheck.afterMs`/`everyMs`, and absolute `worktreeDir` and
  `sandbox.allowWrite` (`~/` expands to the injected home, relative paths resolve against the repo).
- **Durations** are one or more `<n><unit>` parts with units `ms`, `s`, `m`, `h`, `d` (`60m`, `1h30m`); zero is
  invalid.
- **Additions to section 13.** `models.fixer` (default opus), because Settings (15.2) and decision 15 let each role's
  model be chosen. The default `worktreeDir` is `<home>/.mastermind/worktrees/<repo>-<first 6 hex of sha256(repo
  path)>`, with characters outside `[\w.-]` in the repo name replaced by `-`. `commands` default to empty strings,
  meaning "none". The plan's log retention setting (section 20) is not a config key yet.
- **Detection** (`detectProject`) checks sources in this order and the first source to offer a command wins it:
  Makefile (`setup|deps|bootstrap`, `build|all`, `test|check` targets), package.json, Cargo.toml, go.mod,
  pyproject.toml. Each command comes with a `source` such as `package.json script "build" via pnpm (pnpm-lock.yaml)`
  for the Conductor's confirmation question. The Node package manager comes from the lockfile, then the
  `packageManager` field, then npm. Setup is `pnpm install`, `yarn install`, `npm ci` (or `npm install` without a
  lockfile), `cargo fetch`, `go mod download`, `uv sync`, `poetry install` or `python -m pip install -e .`. Python
  gets no build command and pytest as the test command. npm's placeholder test script is ignored. A malformed
  package.json is skipped and reported in `warnings` rather than failing startup.
- **Sandbox presets** (`sandboxPreset(toolchains, platform)`) list registry domains and cache folders per toolchain
  (npm, pnpm, yarn, cargo, go, pip, uv, poetry) for macOS and Linux. Cache folders are stored as `~/…` so the config
  stays readable and portable; `resolveConfig` makes them absolute for the spawn. XDG and other env overrides of
  cache locations are not followed.
- **First run** (`prepareProject`) creates `.mastermind/`, appends `/.mastermind/` and `/.mastermind-result.md` to
  `info/exclude` in the git common dir (it follows a `.git` file's `gitdir:` and `commondir`, without running git),
  and, only when `.mastermind/config.yaml` does not exist yet, writes the detected commands and presets there. Keys
  the committed `mastermind.yaml` already sets are left out, so the committed values stay in effect. It returns
  `{ firstRun: true, detection }` so the Conductor can ask the owner to confirm the commands.
- **Unit test helper.** `packages/core/src/testing/temp-dir.ts` (`makeTempDir`, `writeFiles`) cleans up through
  vitest's `onTestFinished`, since the unit project has no setup file.

## m1-db

- **Where it lives.** `@mastermind/core/db` (`src/db/`, a new package export) is the only place with SQL.
  `openDb(path, { clock })` opens `node:sqlite` with foreign keys on, WAL and a 5 s busy timeout, runs the
  migrations and returns a `Db` with one repository per table group (`tasks`, `sessions`, `events`, `checks`,
  `rebases`, `findings`, `comments`, `chat`, `proposals`, `flags`), plus `transaction`, `killRunning` and `close`.
  The injectable `Clock` (`src/clock.ts`, `now(): Date`) supplies every ISO timestamp.
- **Schema.** Migration 1 is section 12 verbatim (the plan's inline comments are dropped). Additions: indexes on
  the foreign-key-like and status columns, and `runtime_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL)` holding
  JSON values for `paused`, `authRequired` and `backoffResumeAt`, read through `RuntimeFlags` with defaults
  `false`, `false`, `null`. No `REFERENCES` clauses were added, so `task_deps` may name a task that does not exist;
  the import path (7.1) rejects unknown deps.
- **Migrations.** `schema_version` holds one row. All pending migrations and the new version are applied in one
  transaction. An up-to-date database is left untouched. A database newer than the build fails with `SchemaVersionError` instead of being touched. Add a
  migration by appending SQL to `migrations` in `schema.ts`; never edit an applied one.
- **Rows are validated.** Every read goes through a zod row schema that parses JSON columns and enum columns and
  maps snake_case to the camelCase DTO. A bad row throws `InvalidRowError` naming the table and column. Updates of a
  missing id throw `RecordNotFoundError`.
- **Contracts.** The enums and DTOs are in `@mastermind/core/contracts` (`tasks.ts`, `sessions.ts`, `checks.ts`,
  `review.ts`, `chat.ts`, `runtime.ts`, `common.ts`). The event DTO is `SessionEvent`, not `Event`, so it does not
  shadow the DOM `Event` type in the web package. `Task.deps` is sorted. The plan gives no rebase statuses, so
  `RebaseStatus` is `running | succeeded | failed | killed`. `ChatMessage.meta`, `Proposal.args` and
  `Proposal.result` are `JsonValue`; SQL `NULL` reads as `null`.
- **Transactions.** `db.transaction(work)` is synchronous: `BEGIN IMMEDIATE` at the outermost level, savepoints
  when nested, rollback and rethrow on error, and a `TypeError` if the work returns a promise. Repository methods
  that write several rows (task plus deps) use it internally, so they compose inside a caller's transaction.
  A depth counter is used instead of `DatabaseSync.isTransaction`, which Node 22.13 lacks.
- **Proposals are decided once.** `proposals.decide` only moves a `pending` proposal, in one conditional `UPDATE`;
  deciding it again (for example a confirm that arrives after it expired) throws `ProposalAlreadyDecidedError`.
- **Kill path.** `db.killRunning()` is the single synchronous transaction of 3.3 step 2: it sets every `running`
  session, check and rebase to `killed` (sessions also get `ended_at`) and returns the counts for the exit summary.
- **Not yet stored.** m0-spikes asks for descendant pgids of a running session to be recorded for the startup
  reaper. Section 12 has no place for them, so the task that builds the process tracker should add a migration
  (for example a `session_processes` table) rather than reuse `runtime_flags`.
- **Node 22 prints an `ExperimentalWarning` for `node:sqlite`.** The CLI may want to filter that one warning.

## m1-procs-auth

- **Where it lives.** Four Node-side modules with their own package exports: `@mastermind/core/procs`, `/env`,
  `/claude` and `/auth`.
- **Process registry** (`createProcessRegistry()`). `spawn` always uses `detached: true` and registers `{kind, pid,
  pgid}` before the child has even started, so a Ctrl+C that lands mid-spawn still finds it. pgid equals pid
  because Node's `detached` calls `setsid`. An entry leaves the registry on the child's `close` event (exit plus
  stdio closed), so a group whose leader died while an orphan still holds its pipes stays killable. `track` adds
  processes spawned elsewhere (node-pty "Try it" terminals in M6). `exited` resolves to
  `{kind: "exited", code} | {kind: "signaled", signal}`; a command that cannot start rejects `spawn` with
  `SpawnError`.
- **Kinds.** The plan's `session`, `check`, `rebase`, `conductor` and `terminal`, plus **`utility`** for short
  `claude` calls (`--version`, `auth status`, and the login and logout hand-offs), so CLAUDE.md's "every child in
  its own group and recorded" holds for them too.
- **Killing.** `killAllSync()` and `stopGroup`'s escalation share one tree kill (spike 9): a `ps -A -o
  pid=,ppid=,pgid=,stat=` snapshot, then every group reachable from the tracked pids by parent link or shared
  group gets SIGKILL, and a second snapshot catches anything forked meanwhile. Mastermind's own group is never
  signalled as a group; a descendant inside it is killed by pid. `killAllSync` never throws: it returns
  `{counts: Record<ProcessKind, number>, failures}` so the kill path can always finish. `ESRCH` is success.
  **macOS answers `EPERM` to `kill(-pgid)` when the group's only members are unreaped zombies**, so only groups
  with a live (non-`Z`) member are signalled, and a racing `EPERM` counts as success if no live member is left.
  If `ps` itself fails, the tracked groups are SIGKILLed directly and the failure is reported with target
  `"process-table"`. A late `close` only untracks its own entry, so a reused pid is never dropped by mistake.
- **`stopGroup(child, { graceMs = 10_000 })`** sends SIGTERM to the group (claude then cleans up its tool groups,
  exiting 143) and SIGKILLs the whole tree if the child has not closed within the grace period.
- **Line readers.** `io: { stdin, onStdoutLine?, onStderrLine? }` splits UTF-8 output on `\n` and delivers a final
  unterminated line at end of stream; a stream without a handler is `ignore`d so it can never fill a pipe.
  `io: "inherit"` is for the login hand-off. `collectOutput` runs a command to completion and joins its lines.
  Writing to `stdin` is left to the caller, which must handle `EPIPE` when the child has gone.
- **Login hand-off runs detached too**, so `setsid` leaves it without a controlling terminal while it still reads
  and writes the owner's terminal through the inherited descriptors. The fake doesn't read the terminal, so this
  is only proven against fake-claude; m1-startup or a live test should confirm the real interactive login works
  this way, and if it doesn't, make that one call non-detached and record why.
- **Environment cleaning** (`cleanEnv`). Removes **every** `ANTHROPIC_*` variable rather than guessing which ones
  select a provider: in Claude Code each one is a credential, an endpoint or provider setting, or a model-alias
  remap that mastermind's explicit `--model` makes redundant, and a prefix also catches provider variables added by
  newer versions. Also removes `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY}`, the nested-session list of the CLI notes
  and an empty `CLAUDE_CONFIG_DIR`. Every other `CLAUDE_*` variable, including `CLAUDE_CODE_OAUTH_TOKEN`, passes.
- **Argument builder** (`buildClaudeArgs`). The only way to spawn `claude` is `createClaudeCli(...).spawn/run/
  handOff` with a `ClaudeCommand` (`version`, `auth-status`, `auth-login` (always `--claudeai`), `auth-logout`,
  `print`). The forbidden flags have no field, and any value or list item starting with `-` throws
  `ClaudeArgumentError`, so none can be smuggled in. `print` always emits `-p --output-format stream-json
  --verbose --strict-mcp-config` and never a positional prompt (prompts go on stdin). List flags emit one argv
  entry per item (`--tools ""` for an empty list), and `noPermissionPrompts` adds `--permission-prompts none`.
  JSON options (`settings`, `mcpConfig`, `jsonSchema`) take values and are serialised by the builder.
- **Version.** Minimum and tested are both 2.1.283: nothing older was verified, and the spikes rely on recent
  flags. `checkClaude` returns `missing | unreadable | too-old | ok {tested}`, and `describeClaudeCheck` gives the
  install or update hint and the doctor warning for an untested (newer) version.
- **Auth classifier.** The order is: not logged in, then non-`firstParty` provider, then `apiKeySource:
  "apiKeyHelper"`, then `api_key` or `console` (API billing), then `claude.ai` (Pro or Max accepted, any other plan
  refused naming it) and `oauth_token` (accepted only if it reports Pro or Max, as the CLI notes decided). Any
  other `authMethod` is refused naming the method. `Accepted.email` is nullable because a token may not report
  one. `readAuthStatus` parses stdout whatever the exit code, and throws `AuthStatusError` on output that isn't
  the expected JSON. `describeAuth`, `signInPrompt` and `switchAccountWarning` are the 4.2 texts.

## m1-actions-scheduler

- **Where it lives.** `@mastermind/core/actions` (`src/actions/`), `@mastermind/core/events` (`src/events.ts`) and
  `@mastermind/core/scheduler` (`src/scheduler.ts`), all new package exports. Contracts added: `events.ts` (the bus
  union), `actions.ts` (error codes and issues for HTTP and MCP error bodies), task input schemas in `tasks.ts`
  (`taskIdSchema`, `touchPathSchema`, `newTaskSchema`, `taskEditSchema`, for web forms too) and `Summary` in
  `runtime.ts`.
- **Bus events.** The 14.2 list plus two additions: `scheduler.updated` (`paused`, `resumeAt`), emitted by pause,
  resume and every back-off change, and `config.updated` (the merged config), emitted by `setConfig`. 14.2 has no
  event for either, and the UI and Conductor need both. `auth.updated` carries `authRequired` only. A listener that
  throws is reported through `onListenerError` (stderr by default) and never stops other listeners or the action.
- **Actions.** `defineAction({ name, description, input, emits, handler })`. The handler gets `{ db, config, emit }`,
  and `emit` is typed to the declared `emits`, so an action cannot emit an event it doesn't declare.
  `createActionRegistry(context, builtinActions)` returns `register` (duplicate names throw), `list` (name,
  description, zod input, emits: what route, tool and subcommand generators need), `invoke(name, unknown)` and a
  typed `run(definition, input)`. Names are camelCase (`createTasks`, `pause`); m2-mcp maps them to the snake_case
  tool names of 6.3 (`create_tasks`, `pause_all`). Every input is a strict object, so unknown fields are errors.
  Actions that take nothing accept `undefined` or `{}`.
- **Errors.** `ActionError { code: invalid_input | not_found | conflict, issues: {path, message}[] }`; zod paths read
  like `tasks[0].touches[0]` (the config module's formatter is reused). `IllegalTransitionError` is a `conflict`.
  HTTP should map them to 400, 404 and 409.
- **Internal writers.** State the scheduler itself changes (the back-off time) is written by `setBackoff` in
  `actions/runtime.ts`, not by a registered action, so it is never exposed as a route or tool but still lives in the
  action layer. Later internal transitions (session start and end) should follow the same pattern or register
  actions, and must call `assertTransition`.
- **DAG validation** (`findGraphIssues(batch, existing)`) reports, in order: ids used twice in the batch, ids that
  already exist, unknown deps (naming task and dep), and one cycle per strongly connected component that contains a
  batch task, as the shortest cycle through its first batch task (`dependency cycle: a → b → a (each task depends
  on the next)`). createTasks and importTasks validate and insert in one transaction, so nothing is stored on error.
  updateTask validates new deps against all other tasks.
- **Task ids** are lowercase slugs (`[a-z0-9]` runs joined by `.`, `_` or `-`, at most 64 characters), so they are
  safe as branch names and clone folder names. **Touches** must be repo-relative (no leading `/`, no `..`). They are
  compared segment by segment: a trailing `/` doesn't matter, `src/a` and `src/ab` don't overlap, `.` covers the
  whole repo, and an empty list overlaps nothing.
- **State machine** (`actions/transitions.ts`): pending → running; running → checking, pending (interrupted,
  usage limit, auth, or a failure with attempts left), blocked; checking → running (fixer), review, rebasing,
  blocked; review → rebasing (approve), running (request changes), checking (main moved, re-run checks), pending
  (discard); rebasing → done, running (conflict or failure fixer), blocked; blocked → pending (retry). Retry also
  resets attempts to 0. Hold and release only flip the flag, in any status. Later tasks extend the table if they
  need another edge.
- **Controls.** `moveToTop` sets the priority to one above the highest unfinished other task, and leaves a task that
  is already strictly highest alone.
- **tasks.yaml.** Import accepts a list of tasks or a mapping with `tasks`. Known task keys are the six of 7.1 plus
  `priority` (so export, then import, round-trips priorities; export omits a priority of 0). Unknown keys are
  dropped with warnings: one per unknown top-level key, and one per unknown task key with the number of tasks that
  had it. Export writes `deps` and `touches` as flow lists and multi-line text as literal blocks.
- **Scheduler.** `selectReady(state)` is pure: nothing while paused, auth is required or the back-off is in the
  future; otherwise pending, unheld tasks with every dep done whose touches don't overlap a running, checking,
  review or rebasing task, nor a task picked earlier in the same pass, in priority order (then oldest, then id),
  up to `maxWorkers` minus running worker and fixer sessions and starts still in flight. `summarize` gives counts, active workers, `upNext`
  (the same pick ignoring capacity and the pause, auth and back-off gates), blocked ids and `resumeAt` (null once
  passed).
- **Loop.** `createScheduler({ db, bus, clock, maxWorkers, startTask, onError })` ticks every 3 s and on a
  zero-delay timer after `task.updated`, `session.ended`, `scheduler.updated`, `auth.updated` and `config.updated`.
  A tick is synchronous: it calls `startTask` for each selected task without awaiting it, so a slow start (cloning,
  `commands.setup`) never holds up other starts. Until its promise settles, a task is in `SchedulerState.starting`:
  it is not picked again, its touches count as occupied and it takes a `maxWorkers` slot. **`startTask` should
  resolve once the session row is `running` (or the task has left `pending`)**; a brief double count between the two
  only makes the scheduler more cautious. A rejection goes to `onError` and the task is tried again on the next
  interval tick, not immediately, so a start that keeps failing cannot spin.
- **Back-off.** `reportUsageLimit()` waits 5, 10, 20, 40, then 60 minutes, stores the time in
  `runtime_flags.backoffResumeAt`, emits `scheduler.updated` and clears it (emitting again) when it passes. A report
  while a back-off is still running returns the current time unchanged, so two sessions that hit the limit together
  don't double it twice. `reportSuccess()` resets the sequence. The sequence count is in memory, so a restart
  starts again at 5 minutes, but a stored future `resumeAt` is honoured on `start()`.

## m1-events-parser

- **Pulled forward from milestone 2**, because the session manager (m1) needs it.
- **Where it lives.** The stream-json line schemas are browser-safe and sit in `@mastermind/core/contracts`
  (`stream-json.ts`), so the web terminal view can re-read stored payloads. `ExitOutcome` is in `sessions.ts`. The
  parser, exit classifier and structured-output reader are `@mastermind/core/sessions` (`src/sessions/`, a new
  package export).
- **The parser is per process and stateful**: `createStreamParser().parseLine(line)` returns `{type, summary,
  payload, stored, details}`. State is needed to pair a `tool_result` with its `tool_use` (tool name, path and
  command), to show paths relative to the latest `init.cwd`, and to tell a turn's own prompt from a steer. It never
  throws. `details` is a union on `details.line` (`init`, `tool_use`, `assistant`, `api_error`, `tool_result`,
  `user`, `result`, `rate_limit`, `partial`, `permission_denied`, `api_retry`, `vcs`, `other`).
- **`stored: false`** marks the lines the CLI notes' mapping says get no `events` row: later `init`s, the first
  replayed user message of a turn, thinking, successful tool results, rate-limit events, stream events, noise
  system subtypes, `control_response`, unknown types and unreadable lines (all `note`). A tool_result error that
  follows a `permission_denied` for the same tool use is also not stored, so a denial shows once.
- **The turn ends on `details.line === "result"`**, not on the event type (a failed result is `error`). Every
  result field is lenient (`.catch(null)`), so a result line is always recognised and a session can't hang on a
  changed field.
- **Commits** come from the Bash `tool_result`: the CLI's `tool_use_result.gitOperation.commit` (sha, branch), or a
  `git commit` command whose output has git's `[branch sha] subject` line. The subject comes from that line, else
  from the command's `-m`. `system/vcs_state_changed` with `kind: "commit"` is kept as an unstored `commit` event so
  each commit shows once, and it marks the next successful tool_result as a commit even when neither of the above
  is present (a quiet commit, or one made by a script); other kinds are notes.
- **A turn's own prompt** is the first replayed user line after the process starts or after a `result`. `init` does
  not reset this, so the order of `init` and the replayed prompt doesn't matter.
- **Summaries:** `Run <first line of command>` (not `input.description`), `Edit|Write <relative path>`,
  `Read <path>`, `Grep "<pattern>"`, MCP tools by full name, `<Tool> failed: <reason>` where the reason prefers a
  `<sandbox_violations>` entry and joins `Exit code N` with the next line. Summaries are one line of at most 160
  characters.
- **`classifyExit(resultEvent, exitCode, stderr, events)`** takes the run's parsed events as a required fourth
  argument (required so a caller can't silently skip the rejected rate-limit and synthetic error rules), because the auth and usage-limit rules also read synthetic assistant errors and rejected rate-limit
  events. A run with exit 0 and a non-error result is `succeeded` before any other rule, so text in a good run
  can't trigger a back-off. Text rules apply to an error result's text and to stderr. `resetAt` is the latest
  **rejected** `rate_limit_event`'s `resetsAt` (an `allowed` event's window may not be the limit that was hit);
  without one the scheduler's default back-off applies.
- **`readStructuredOutput(resultEvent, schema)`** returns `result.structured_output` validated by the caller's zod
  schema, or throws `StructuredOutputError` with reason `no-result`, `error-result`, `missing` or `invalid`. It
  never falls back to `result.result`.
- **Tests** live in one file, `sessions/parser.test.ts`, so the acceptance filter `parser` runs all of them. Every
  `.jsonl` sample must have an expected table, and every line in the samples must be recognised or a listed noise
  type, so a new recorded sample or a changed CLI shape fails loudly.
