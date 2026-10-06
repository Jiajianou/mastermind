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
  `FAKE_CLAUDE_LOGIN_ACCOUNT` (account a login produces, default `max`), `FAKE_CLAUDE_LOGIN_FAIL=1` and
  `FAKE_CLAUDE_LOGIN_WAIT=1` (the login never finishes, like one waiting on the browser).
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
  (`variant`, `signOut`) and `crash` (`afterMs`).
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

## m1-sessions

- **Where it lives.** `@mastermind/core/git` (`src/git/`, a new package export) runs git through the process
  registry (`collectOutput`, kind `utility`): `execFile`-style argv, never a shell, and still detached and tracked
  so Ctrl+C twice reaches it. `GitError` carries the args, exit and stderr. The session code is in
  `@mastermind/core/sessions`: `spawner.ts` (shared by every role), `manager.ts` (workers), `settlement.ts` (pure
  outcome rules), `settings.ts`, `path-guard.ts`, `setup.ts`, `prompts.ts` and `actions.ts` (`stopSessionAction`).
- **Clones** (`createTaskClone`): `clone --local --single-branch --branch <main>`, `switch --create task/<id>`,
  `remote remove origin`, `/.mastermind-result.md` appended to the clone's `.git/info/exclude`, and the repo's
  effective `user.name`/`user.email` copied into the clone's config, because a clone doesn't inherit the repo's own
  `.git/config` and every commit must carry the owner's identity (decision 18). The fetches use `+` refspecs (a
  rebased task branch is not a fast-forward of the last fetched ref) and `--no-write-fetch-head`, so the owner's
  repo gets no `FETCH_HEAD`. `deleteClone` refuses any path that isn't inside `worktreeDir`.
- **Workspace reuse.** A task whose `worktree` still exists reuses it (retries, resumes), and `commands.setup` runs
  only when a clone is created. A directory left at `<worktreeDir>/<id>` that the task doesn't reference (a crash
  mid-clone) is deleted and cloned again. The task's `worktree`, `branch` and `base_commit` are stored after setup,
  so a crash during setup clones and sets up again. A failed setup doesn't stop the worker; its prompt says that
  setup failed and where the log is. Setup logs are `.mastermind/logs/checks/<task>-setup-<time>.log`; the raw
  stdout of each session is `.mastermind/logs/sessions/<id>.jsonl` (stderr, if any, beside it as `<id>.stderr`).
- **Mastermind's own commits** (`commitLeftovers`) run with `-c core.hooksPath=/dev/null --no-verify`, because a
  `prepare-commit-msg` or `commit-msg` hook in the managed repo could add a trailer or reject the WIP message.
- **end_commit is recorded after the WIP commit**, not before as 8.4 lists the steps, so that "changes since the
  previous round" (9.1) diffs against everything that round produced.
- **Spawn flags.** The worker gets 8.3 plus the CLI notes' additions: `--strict-mcp-config`,
  `--replay-user-messages` and `--permission-prompts none`. `--settings` holds attribution off, the decision 9
  sandbox block (or `{enabled: false}` when the owner turned it off, so a user-level sandbox setting can't apply),
  deny rules and the path guard hook. **Presets reach the sandbox through config**: `prepareProject` wrote them into
  `.mastermind/config.yaml` on the first run, so `sandbox.allowWrite` and `allowedDomains` are used as configured.
- **Deny rules** cover Edit and Write under the owner's repo and `~/.claude` (each also under its real path, for
  `/tmp` → `/private/tmp`). A protected path that contains the worktree is skipped, since deny beats allow.
- **Path guard.** The CLI notes found deny rules can't confine Edit and Write to the worktree, so every editing
  session gets a `PreToolUse` hook on `Edit|Write|MultiEdit|NotebookEdit`. `SessionManagerOptions.pathGuardCommand`
  is **required**: the argv prefix of a command that reads the hook JSON on stdin, prints
  `pathGuardResponse(stdin, worktree)` and exits 0; the worktree is appended as the last argument and the whole
  command is shell-quoted. The CLI must provide it (for example a hidden `mastermind path-guard <worktree>`
  subcommand run with `process.execPath`); fake-claude ignores hooks, so only the unit tests exercise the guard.
- **Permission mode check.** If the first `init` reports a `permissionMode` other than the requested one (auto on
  a model without it), the spawner stops the session and it ends `failed` with a reason naming both modes. That
  counts an attempt but doesn't back off, since it is a configuration problem.
- **Ending a run.** At the `result` line stdin is closed; the run is classified when the process exits. If it
  lingers more than 30 s after its result it is stopped, and the exit code is then treated as 0 so the result line
  alone decides. Outcomes (`settleWorkerRun`):
  - succeeded: WIP commit, `end_commit`, task → `checking`, back-off sequence reset.
  - rate_limited: task → `pending`, no attempt, back-off until the rejected `rate_limit_event`'s `resetsAt` if it
    is in the future (`Scheduler.reportUsageLimit(resetAt?)` gained this optional argument), else the default
    sequence.
  - auth_failed: `authRequired` and `paused` set (4.3), `auth.updated` and `scheduler.updated` emitted, task →
    `pending` with no attempt. Running `claude auth status` first, as the CLI notes suggest, and resuming after a
    good check are left to the auth-expiry flow (M8).
  - failed (unrecognised): **counts an attempt** (`blocked` at `maxAttempts`), as this task's goal says, **and**
    backs off globally, as the CLI notes say, since it may be an unseen limit text. Counting attempts replaces the
    notes' separate per-task count of consecutive unrecognised failures. The reason is stored as an `error` event
    (`Session failed: …`), which is where a blocked task's message comes from.
  - stopped (`stopSession`): task → `pending` and **held**, so it doesn't restart by itself; releasing it resumes
    the session. No attempt is counted and nothing is committed.
- **Resuming.** Rate-limited, auth-failed and stopped runs set `resume_session` only if the conversation got
  going (an assistant or tool_use line). A run that failed before any of that, such as "Not logged in", may have
  no stored conversation, and `--resume` would fail with "No conversation found". A resumed start passes `--resume
  <id>` instead of `--session-id`, keeps the same `claude_session_id` on its new session row, sends `You were
  interrupted. Check the worktree state and continue.` and clears `resume_session`.
- **Session rows.** The row is created (with the task's move to `running`) before the spawn, so no early line can
  arrive without a session id; pid and pgid are filled in once the child starts. If the spawn itself fails, the
  session ends `failed` and the task returns to `pending` unchanged. `attempt` is `task.attempts + 1`.
  `input_tokens` is input plus cache reads plus cache creation from each `result`'s usage, summed over the
  process's results; `output_tokens` is the output total.
- **Git location variables.** `cleanEnv` also drops `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and the other
  repository-locating variables, and the git runner uses `cleanEnv` too. If mastermind is started from inside git
  (a hook or an alias), these would otherwise point mastermind's own git, the setup command and the worker's git
  at the owner's repository instead of the task clone, which breaks decision 20.
- **Not done here.** Descendant pgids are still not recorded while a session runs (m1-db's note), which the
  recovery task may want for its reaper.

## m1-recovery-lock

- **Where it lives.** `@mastermind/core/lock` (`src/lock.ts`) and `@mastermind/core/recovery` (`src/recovery.ts`),
  both new package exports. `procs.ts` now exports `readLiveProcess(pid)` (`ps -p <pid> -ww -o pgid=,stat=,command=`,
  `null` for a missing or zombie process) and `killTreesSync`, the same descendant-group kill the registry uses.
- **Lock file.** `.mastermind/lock` is JSON `{"pid": …, "port": …}`; the port is `null` until the server has one
  (`InstanceLock.setPort`, step 7 of 3.1), because the lock is taken at step 2. `acquireLock` creates
  `.mastermind/` itself, since first-run setup comes later. Creation is atomic: the record is written to a temp file
  and hard-linked into place, so the lock appears whole or not at all (EEXIST means taken). Port updates are a
  temp file plus rename. The API is synchronous, because the Ctrl+C kill path must release it synchronously.
- **Stale and live.** A lock is stale if its pid is dead (`kill(pid, 0)` gives ESRCH), its content is unreadable,
  or its pid is our own (a pid reused from an earlier run). A stale lock is renamed aside and deleted only if the
  moved file is still the one that was judged stale; otherwise it is another instance's fresh lock and is put back.
  A live lock returns `{kind: "held", pid, link}`; the link is `http://127.0.0.1:<port>/#t=<token>` built from
  `.mastermind/token`, or `null` while the holder has no port or token yet. `alreadyRunningMessage` gives the 3.1
  text (`…, still starting` without a link). Holder liveness is the pid alone, as the task says; a reused pid can
  wrongly look live until that process exits.
- **Release** (`releaseSync`) deletes the file only if it still holds this instance's exact record, so an instance
  whose lock was taken over never deletes the new holder's lock. `readLock(stateDir)` is for clients (m2-cli-client)
  looking for the running instance's port.
- **Recovery order** (`recoverPreviousRun({ db, git })`): reap every `running` session's leftover process first,
  then commit the clones of `running` tasks, then one transaction runs `db.killRunning()` (sessions, checks and
  rebases → `killed`) and requeues the tasks. Work is saved only after its writer is dead, and a crash part-way
  leaves rows as they were, so the next start simply repeats recovery.
- **Reaping.** A session's group is killed only if `readLiveProcess(pid)` finds the process and its command line
  contains the session's `claude_session_id`. That covers `--session-id <id>` and the `--resume <id>` of a resumed
  run. The kill uses the live process's pgid and the descendant-group tree kill, so Bash tool groups under it die
  too. Sessions of every role are reaped and marked killed.
- **Saving work.** Only tasks left `running` are committed (`WIP: interrupted`, through `commitLeftovers`, so hooks
  are off and there are no trailers). Clones of tasks in `checking` or `rebasing` are left alone: they may hold
  build output or a rebase in progress. A failed commit (for example a stale `index.lock` from a killed git) is
  reported in `failures` and the task is still requeued.
- **Requeue.** `running` tasks go to `pending` with attempts and `held` unchanged. `resume_session` is the latest
  worker or fixer session's claude id **only if that conversation got going** (a stored assistant or tool_use line
  in any run with that id, re-read with the stream parser), matching m1-sessions' rule for usage limits; otherwise
  it is `null` and the task starts fresh, because `--resume` of a conversation that never started fails.
  Thinking-only assistant lines are not stored as events, so a run killed after thinking but before its first
  text or tool call also starts fresh; that is the safe side of the rule.
- **Not done here.** Tasks left in `checking` or `rebasing` keep their status with their checks and rebases marked
  killed; the checks pipeline and rebase queue (M5) must re-run them on start. Check and rebase processes have no
  pid in the database, so an orphaned `make test` from a hard-killed run is not reaped, and neither is a Bash tool
  group whose claude parent also died (descendant pgids are still not recorded). The report (`reaped`, `saved`,
  `requeued`, `killed`, `failures`) is for m1-startup to print; recovery emits no bus events because it runs before
  the server starts.
- **Test.** The recovery test runs a real "previous mastermind" (`test/integration/recovery/previous-run.ts`, via
  `node --import tsx`) whose session manager starts a fake-claude worker, then SIGKILLs that process so the fake is
  a true orphan before recovery runs against the same database file.

## m1-startup

- **Where it lives.** `@mastermind/core/startup` (`src/startup/`, a new package export) holds every step, so tests
  drive it without a terminal. `startMastermind` runs 3.1 steps 1 to 6 in order (repo, lock, Claude Code check, auth
  gate, branch guard, first run, recovery) and prints the 3.4 banner last. It returns a `Startup` with the repo root,
  branch, merged config, accepted account, first-run detection, recovery report, lock, db, git, claude CLI and an
  idempotent `close()` (closes the db, releases the lock). Any failure after the lock is taken closes the db and
  releases the lock before rethrowing. Each step is also exported (`findRepo`, `takeLock`, `requireClaudeCode`,
  `passAuthGate`, `guardBranch`, `loadProjectConfig`).
- **Injected IO.** Steps talk to the owner only through `StartupPrompts` (`say`, `pressEnter`, `choose(question,
  choices, cancel)`); spawning goes through the injected `ProcessRegistry`, env and home. The CLI's
  `terminal-prompts.ts` implements it: on a TTY, single keys in raw mode (Enter, Esc, `q`, Ctrl+C, arrows or j/k with a
  `▸` marker); otherwise numbered menus read line by line from stdin, where end of input means Esc or Quit. Raw mode
  is held only while a key is awaited and stdin is paused afterwards, so the login hand-off owns the terminal.
- **Failures** are `StartupError { failure }` (`unsupported-platform`, `not-a-repo`, `already-running`,
  `claude-unavailable`, `account-refused`, `sign-in-failed`, `config-invalid`, `quit`). The CLI prints the message to
  stderr and exits 1; any other error is printed as `mastermind: <message>` with exit 1. Quitting at any prompt exits 1,
  because mastermind did not start.
- **Auth gate.** Texts are those of `auth.ts` (4.2). A failure is any sign-in attempt after which the check still isn't
  accepted; after 3 the gate stops with `sign-in-failed`. A non-zero `claude auth login`/`logout` exit is reported in a
  line before the re-check. **Deviation:** the switch-account choice is offered only for API billing, a non-Pro/Max
  plan or an unknown method. For another provider, an `apiKeyHelper` or `CLAUDE_CODE_OAUTH_TOKEN`, the cause is in the
  environment or Claude settings, which a new sign-in leaves in place, so mastermind prints the refusal and exits
  instead of signing the owner out everywhere for nothing.
- **Login hand-off stays detached** (m1-procs-auth's open question). A `setsid` child with no controlling terminal
  can still read and set modes on the inherited tty descriptors, since job-control checks only apply to processes
  whose controlling terminal it is. Verified with fake-claude under a real pty (`script`); the real interactive login
  is still unverified live.
- **Branch guard.** It runs before first-run setup, so it reads `mainBranch` from defaults and both config files without
  writing anything. "New branch" is `git switch --create dev`, or `dev-2`, `dev-3`… if `dev` exists. "Existing branch"
  lists local branches other than main, plus Quit. If `git switch` refuses (local changes that would conflict), the
  reason is shown and the menu comes back. A detached HEAD is not main and passes.
- **First run** prints `First run: wrote .mastermind/config.yaml.` and the detected commands. The `mainBranch` is not
  detected (a repo whose main branch is `master` needs it set in config); `prepareProject` would be the place.
- **`--port` and `--open`** are parsed and validated (zod, 1 to 65535). `Startup.port` is `--port` or `config.port`, the
  port step 7 tries first. Until m1-runtime-tui and the server exist, `mastermind .` closes the startup and exits 0
  after the banner; the runtime task replaces that tail and uses `--open`.
- **Doctor** (`runDoctor` returns `{name, level: ok | warning | error | skipped, message}` for `git`, `claude`,
  `sign-in`, `attribution`, `config`, `worktrees`, `sandbox`; `formatDoctorReport` renders `✓ ! ✗ -`). Only `error`
  fails (exit 1); a check skipped because another one failed doesn't count again. Attribution reads `settings.json` in
  `CLAUDE_CONFIG_DIR` (else `~/.claude`) and warns, not fails, because layer 2 already turns it off per spawn. Worktree
  usage is `du -sk` of the resolved `worktreeDir` (hard-linked objects are counted, so it overstates the extra disk).
  The sandbox check needs `/usr/bin/sandbox-exec` on macOS and `bwrap` plus `socat` on PATH on Linux, and warns if
  the project turned the sandbox off. Doctor writes nothing and takes no lock.
- **Small core changes.** `locateOnPath` moved to `src/executables.ts` (shared by claude and doctor), `auth.ts`
  exports `AcceptedAuth` and `planLabel`, config exports `resolveConfigPath`, `hostPlatform`, `isMissingFileError` and `readOptionalFile`, and `projectPaths` gained `database`
  (`.mastermind/db.sqlite`).
- **Bundling fixes.** The CLI bundle is the first to include core's db and config: tsup's default `removeNodeProtocol`
  turned `node:sqlite` into `sqlite`, so it is now off; and `yaml` (CommonJS) failed when inlined into ESM, so `yaml` is
  a CLI dependency and stays external. Any new third-party dependency of core must be added to the CLI too.
- **Tests.** `test/integration/startup/` drives `startMastermind` with scripted prompts, and runs the CLI from source
  (`test/support/cli.ts`, `node --import tsx`) for the refusal and not-a-repo exits. `test/integration/doctor.test.ts`
  runs `mastermind doctor` the same way, with stub `bwrap` and `socat` on PATH so it passes on Linux CI.

## m1-runtime-tui

- **Where it lives.** `@mastermind/core/runtime` (`src/runtime.ts`) wires one bus, the action registry (builtins plus
  `stopSession`), the scheduler and the session manager over the `Startup`, keeps the resolved config current
  through `setConfig`, and exposes `togglePause`, `killProcessesSync`, `markKilledSync` and `closeSync`.
  `@mastermind/core/status` (`src/status.ts`) is the one store the terminal view reads: `getSnapshot`/`subscribe`
  (shaped for `useSyncExternalStore`), rebuilt from SQLite and `scheduler.summary()` on every bus event. Running
  checks are counted from `check.updated` events, since the checks table has no running query. The CLI side is
  `foreground.ts` (signals, view, kill path), `ctrl-c.ts`, `kill-path.ts`, `plain-log.ts`, `terminal-commands.ts`
  and `tui/*.tsx`.
- **Event lines.** The five lines come from bus events, not from every stream line: session start (`Start worker,
  attempt 1 of 3`) and end, commits and errors, setup and later checks, rebases, a task reaching review, blocked or
  done, pause and resume, usage-limit waits and sign-in changes. Every other session event only updates that row's
  activity column. `store.notice` adds mastermind's own lines (runtime errors, key feedback). Chat, terminal,
  proposal and shutdown events don't rebuild the snapshot at all.
- **Header.** Shows `mainBranch @ <short sha>` read once at start (null if the branch can't be resolved), because the
  owner works on another branch (decision 6). Nothing moves main in M1; M5's rebase queue should refresh it.
- **Link line** is a placeholder (`Web app → not served yet …`) because `StatusHeader.link` is `null` until m2 starts
  the server. `o` and `c` already run `open`/`xdg-open` and `pbcopy`/`wl-copy`/`xclip` through the process
  registry (kind `utility`), and print a notice while there is no link. `--open` does the same as `o` at start.
- **Ctrl+C machine.** `stepCtrlC(state, input)` is pure and works on timestamps, so a press that arrives after the
  2 s window while its timer is still queued re-arms instead of firing. `createCtrlCGuard` drives it with
  `setTimeout` on `performance.now()`, and re-arms the timer for the remainder when it fires before `expiresAt`
  (libuv timers count from the loop's cached time), so the footer can never stay armed. The Ink `\x03` key (Ink runs with `exitOnCtrlC: false`) and `SIGINT` both call `guard.press()`.
  Without a TTY on both stdin and stdout, the view is plain log lines (the header, the link line, every event line,
  and the armed warning when it arms).
- **Kill path** (`runKillPath`) is fully synchronous and never stops part-way: `killAllSync`, `db.killRunning()`,
  Ink `clear` plus `unmount`, `closeSync` (scheduler stop, db close, lock release), the summary through `writeSync`
  (stdout to a pipe is asynchronous on macOS and `process.exit` would cut it off), then any step failures on stderr.
  The summary counts come from the transaction, or from the registry's kill counts if it failed. Tasks stay
  `running`; the next start's recovery requeues them (3.5). It runs in about 50 ms on macOS.
- **Exit codes, a deviation.** Ctrl+C twice exits 130 as 3.3 says; SIGHUP exits 129, SIGTERM 143 and an uncaught
  exception 1 (with the error on stderr), so callers can tell the causes apart. All four run the same kill path.
- **Path guard command.** The CLI has a hidden `mastermind path-guard <worktree>` subcommand, and the session
  manager gets `[process.execPath, ...process.execArgv, process.argv[1], "path-guard"]`. With the built binary that
  is `node …/dist/index.js path-guard`. Run from source (`node --import tsx`), the hook would resolve `tsx` from the
  worktree and fail, so live runs need the built binary.
- **Prompts directory** is `<repo>/prompts/`, found relative to the CLI module (`src/` and `dist/` are at the same
  depth), which matches the install-from-repo decision 10.
- **JSX and tsx.** The CLI tsconfig sets `jsx: react-jsx`. tsx only applies a tsconfig whose `include` covers the file,
  so `test/support/cli.ts` runs the CLI source with `cwd` = `packages/cli`; from the repo root, tsx would compile
  JSX in classic mode and fail with `React is not defined`. `spawnCli` there is the shared helper for long-running
  CLI tests. ESLint applies the React hooks rules to `packages/cli/src/**/*.tsx`.
- **Dependencies.** `ink` 8 and `react` 19 are CLI dependencies (external to the tsup bundle);
  `ink-testing-library` and `@types/react` are CLI dev dependencies.

## m1-verify

- **Where it lives.** `test/e2e/m1-runtime.test.ts` runs the built binary (`packages/cli/dist/index.js`, through
  `spawnBuiltCli` in `test/support/cli.ts`) against temp repos and fake-claude, with plain-log output (no TTY). Tasks
  are seeded through `importTasks` on the action registry before mastermind starts; the repo sets `maxWorkers: 2`.
  The e2e project needs a fresh `pnpm build` first (the gate builds before `test:e2e`).
- **The dependent task.** The scheduler only starts a task whose deps are `done`, and in M1 nothing moves a task
  from `checking` to `done` (that is M5's checks pipeline and rebase queue). So the test plays that part: once both
  parallel tasks are `checking`, it checks the dependent has not started, sets the two to `done` in SQLite, and
  waits for the dependent to reach `checking`. Order is asserted from session rows: the two parallel sessions
  overlap, and the dependent's session starts after the deps were finished.
- **Resume.** The fake's scenario answers `--resume` invocations with a short finishing turn, so after the restart
  the killed tasks reach `checking` with `attempts` 0, and the log shows `--resume` with the killed claude ids.
- **Defect fixed: signals during startup.** The runtime only trapped signals once startup had finished, so a SIGINT,
  SIGHUP or SIGTERM during startup (the login hand-off, a git call, building the runtime) hit Node's default
  handler: mastermind died and left its detached children, such as a login waiting on the browser, orphaned.
  `runForeground` now traps all three from the start (`exitOnSignalsDuringStartup` in `foreground.ts`) and runs the
  kill path on the first one, since nothing is running yet: kill the registry's children, close the startup if it
  finished, exit 129/130/143. The trap is removed in the same tick the runtime installs its own handlers. A signal
  that lands inside `startMastermind` after the lock is taken leaves a stale lock, which the next start takes over.
  fake-claude gained `FAKE_CLAUDE_LOGIN_WAIT=1` to test this (`test/integration/kill-path.test.ts`).

## m2-http-ws

- **Where it lives.** `@mastermind/core/api` (`src/api/`, a new package export): `serveApi` writes the token, builds
  the Fastify app (`server.ts`), listens with the port fallback (`listen.ts`) and records the port in the lock.
  `local-request.ts` holds the Host, Origin, bearer and WebSocket token checks, `read-routes.ts` and
  `action-routes.ts` the routes, `stream.ts` the WebSocket, `errors.ts` the error bodies. `createRuntime` serves the
  API (so `RuntimeOptions` gained `webRoot`), puts the link in the status header and closes the server first in
  `closeSync`. `StatusHeader.link` is now always a string, and the M1 "not served yet" placeholder is gone.
- **Contracts** (`contracts/api.ts`): `apiErrorSchema` (`invalid_input | not_found | conflict | unauthorized |
  forbidden | internal`, with `issues: {path, message}[]`), `actionRoutes` (action name → method and path),
  `ActionResults` (each routed action's result type), the read response schemas (`apiResponseSchemas`, `ApiSummary`,
  `TaskView`), the query schemas and the stream constants. The action input schemas moved from the action modules to
  `contracts/actions.ts`, so the web app validates with the same zod schemas the server does. `builtinActions` and
  `stopSessionAction` are checked against `ActionResults` with `satisfies ContractedActions<…>`, so a handler whose
  result drifts from the contract fails typecheck.
- **Generated mutation routes.** Every registered action needs an entry in `actionRoutes`; `createApiServer` throws
  for one that has none, so a new action can't silently miss its route. Path parameters are named after input
  fields (`/api/tasks/:taskId/hold`) and merged over the JSON body, and `intParams` turns digit-only values into
  numbers (`sessionId`). The input goes through `registry.invoke`, so HTTP validation is the action's own schema and
  errors name the field (`tasks[0].id`, `priority`, `colour: unknown key`). Routes beyond 14.1's list:
  `POST /api/tasks/:taskId/priority` (setPriority), `PATCH /api/config` (setConfig) and `POST /api/tasks/export`
  (exportTasks; POST so it can't collide with a task whose id is `export`). `stopSession` now returns the stopped
  session. Status codes: 400, 404, 409 from `ActionError`, 400 for `ConfigError` and Fastify's body errors, and 500
  `internal` for anything else, which is also passed to `onError` (the terminal's notice line).
- **Reads.** `GET /api/summary` is the scheduler summary plus `activeSessions` (running session rows) and
  `rebaseQueue` (tasks in `rebasing`, oldest first; M5 owns the real queue). `GET /api/tasks[/:taskId]` adds
  `unblocks`. `GET /api/sessions?taskId=&since=` lists sessions (new `db.sessions.list`); `since` keeps sessions
  started at or after it plus every running one, for "active, then finished today". `GET
  /api/sessions/:sessionId/events?after=<event id>` pages a timeline and is 404 for an unknown session.
- **Local-only checks** (section 20). Every request, static files included, must carry a `Host` of `localhost`,
  `127.0.0.1` or `[::1]` (any port), and an `Origin`, when present, of `http://` one of those; otherwise 403. That
  stops DNS rebinding (the browser sends the attacker's host name) and cross-site requests. Every API route then
  needs `Authorization: Bearer <token>` (compared in constant time), else 401 with `WWW-Authenticate: Bearer`. The
  token hook is registered in the encapsulated Fastify context that holds the API routes, never as a check on the
  raw URL: the router matches the percent-decoded path, so a prefix test let `/%61pi/pause` through without a token.
  **The web app's own files need no token**: a browser opening the printed link can't send a header, and the bundle
  holds no data. Unknown non-API GETs fall back to `index.html`; unknown `/api` paths are a JSON 404 (they match no
  route, so they reveal nothing and need no token). There are no CORS headers, so a foreign page can't read responses even where it could send.
- **WebSocket auth: a subprotocol**, not a first message. The client offers two protocols,
  `streamProtocols(token)` = `["mastermind", "mastermind.token.<token>"]`, and the server answers `mastermind`, so
  the token is never echoed. The check runs on the HTTP upgrade, so a bad token is a plain 401 (a foreign Origin 403,
  another path 404) and no unauthenticated socket ever exists, which a first-message scheme can't promise. The `ws`
  server runs with `noServer` on Fastify's own `http.Server`, without per-message deflate, so every send is written
  synchronously. Messages are `BusEvent` JSON (`streamMessageSchema`); clients don't send anything.
- **`service.stopping`.** The stream's `closeSync` sends it, closes each client with code 1001 and destroys the
  sockets, all synchronously, as part of `runtime.closeSync` on the kill path. It is best-effort: a frame the kernel
  can't take at once is lost when the process exits. In practice it arrives (the e2e test checks it on SIGTERM).
- **Ports.** `Startup.port` is now `{ first, exact }`: the config port (default 4700) falls back through the next 99
  ports; `--port` is exact and fails with `port N is already in use`, because an explicit port the owner asked for
  should not quietly become another. The server listens on our own `http.Server` (Fastify's `serverFactory`) so a
  busy port can be retried, which `fastify.listen` doesn't allow.
- **Token file.** 32 random bytes as hex, written to a temp file created with mode 600 and renamed over
  `.mastermind/token`, so an older token file with looser permissions is replaced rather than reused. The token is
  written before the port reaches the lock, so a second instance's "already running" link is never half made.
- **Self-contained build.** The CLI's tsup `onSuccess` copies `packages/web/dist` to `dist/web` and `prompts/` to
  `dist/prompts`; `@mastermind/web` is a dev dependency of the CLI so `pnpm -r build` builds web first. `src/assets.ts`
  uses those copies when they sit next to the running module (the bundle) and the repo's folders otherwise (running
  from source). `fastify`, `@fastify/static` and `ws` are CLI dependencies, so tsup keeps them external.
- **Tests.** `test/integration/api/` (`http.test.ts`, `ws.test.ts`) serve a real server on a free port over a temp
  database and the real action registry, with `stopSession` backed by a stand-in that ends the row. They fail on any
  error the API reports through `onError`. `test/e2e/web-server.test.ts` runs the built binary: printed link, lock
  port, bundled `index.html`, an authorised read, and `service.stopping` with close code 1001 on SIGTERM.

## m2-mcp

- **Where it lives.** `@mastermind/core/conductor` (`src/conductor/`: `mcp.ts` the transport and route, `tools.ts`
  the tool table, `plan.ts` propose_plan) and `@mastermind/core/proposals` (`src/proposals.ts`, the gate and the
  `confirmProposal` / `rejectProposal` actions). The read models moved out of `api/read-routes.ts` into
  `src/reads.ts` (`createReadModels`), shared by the HTTP reads and the MCP read tools. `src/chat.ts` has
  `postChatMessage` (append plus `chat.message`). Contracts: `contracts/conductor.ts` (`mcpPath`,
  `awaitingConfirmationSchema`, `proposalOutcomeSchema`, `proposePlanInputSchema`, `planMetaSchema`,
  `sessionEventsInputSchema`). SDK: `@modelcontextprotocol/sdk` 1.31 (1.32 was newer than pnpm's minimum release
  age, which would have needed an exclusion in `pnpm-workspace.yaml`).
- **Transport.** `POST /mcp` is stateless Streamable HTTP with plain JSON responses (`enableJsonResponse`), as
  spike 6 asks; `GET` and `DELETE` answer 405. Every POST builds a fresh `McpServer` and transport, so the tool list
  and descriptions always follow the current config, and nothing outlives the request. The route is registered in
  the same Fastify context as the API routes, so it gets the same bearer-token hook and the Host and Origin checks.
- **Tools.** Action tools are a table (`actionTools`) mapping a snake_case tool name to a registered action, with a
  description written for the model and `describe(input)`, a short imperative phrase ("Hold sched-prio") used for
  decision boxes and system messages. A tool is listed only when its action is registered, and its input schema is
  the action's own zod schema, so later tasks add `message_session`, `request_changes`, `approve_rebase`,
  `discard_task` and the rest by registering the action and adding one table entry. Read tools wrap the read
  models; `get_session_events` adds `limit` (default 50, at most 200, the latest events) so a long timeline can't
  flood the Conductor's context. Results are the JSON of the action or read result. `ActionError` and `ConfigError`
  become tool errors (`isError`) with their message; invalid arguments are rejected by the SDK with the field path;
  any other error is a tool error too and goes to `onError`.
- **Gating.** Only action tools can be gated: names in `config.conductor.confirm` that aren't action tools (read
  tools, `propose_plan`, tools not built yet) are ignored. The list is read on every call, so a `set_config` change
  takes effect on the next call. A gated call validates its input first (nothing is stored for invalid input),
  stores a `proposals` row with the action name and the parsed args, emits `proposal.updated`, appends a `proposal`
  chat message (the question, `meta: { proposalId }`), and returns `{ status: "awaiting_confirmation", proposalId,
  question }`. A gated tool's description says so.
- **Deciding.** `confirmProposal` and `rejectProposal` are registered actions with routes
  `POST /api/proposals/:proposalId/{confirm,reject}`; they are not tools, so the Conductor can't confirm its own
  proposals. Confirm runs the action exactly once: a confirm that arrives while the action runs joins the same
  promise, and a confirm or reject of a decided proposal returns it unchanged. A confirmed action that fails with an
  `ActionError` or `ConfigError` is still `confirmed`, with `result: { ok: false, message }`; any other failure is
  recorded the same way and rethrown. Success stores `result: { ok: true, value }`. Every decision emits
  `proposal.updated` and appends a `system` chat message (`"Hold sched-prio: declined by the owner."`,
  `meta: { proposalId, status }`); the ChatRunner (next task) feeds system messages newer than the Conductor's last
  turn into its next turn.
- **Expiry rule.** A proposal still pending **60 minutes** after it was made expires (`proposalLifetimeMs`): long
  enough for the owner to step away, short enough that a stale decision doesn't run against a state that has moved
  on. It is enforced when someone confirms or rejects it (it becomes `expired` instead) and by a sweep the runtime
  runs at start and every minute, which posts the system message. A proposal whose action is running never expires.
- **propose_plan** takes the `create_tasks` fields plus an optional `note` per task, checks the batch as a DAG
  against existing tasks (`assertValidBatch`, now exported from the actions), and appends a `plan` chat message: a
  numbered list `1. id: note` (the title when there is no note), with `meta: { tasks }` holding the exact
  `create_tasks` input, so the UI's Start button can post it to `POST /api/tasks` as is. It creates nothing.
- **Review.** `proposalMetaSchema` (`{ proposalId, status? }`) types the meta of `proposal` and `system` decision
  messages, for the web decision box. A failure while recording a confirmed action's success no longer records it a
  second time as a failure, and a rejected `McpServer.close()` goes to `onError` instead of being left unhandled.

## m2-conductor

- **Where it lives.** `src/conductor/`: `runner.ts` (the ChatRunner), `turn.ts` (per-turn recorder: deltas, reply,
  tool calls, context tokens), `action-line.ts`, `digest.ts`, `prompt.ts` (turn framing), `event-lines.ts` (6.4),
  `mcp-config.ts` and `chat-actions.ts` (`sendChat`, `stopChat`). `db.conductorSessions` is the repository for the
  `conductor_sessions` table; `db.chat.list(afterId?)` pages. `createRuntime` wires it all: the runner is created
  before the API is served (its actions need routes), and `.mastermind/run/conductor-mcp.json` is written once the
  port and token are known.
- **Runner: one persistent process**, as the CLI notes decided. Spawn flags are 6.2 exactly (`--tools
  "Read,Grep,Glob"` and `--allowedTools "mcp__mastermind__* Read Grep Glob"` as single arguments) plus the notes'
  `--strict-mcp-config` and `--replay-user-messages`. cwd is the repo root, the env is cleaned by `ClaudeCli`, the
  process is registered as kind `conductor`, and each process gets a `sessions` row (role `conductor`, taskId null)
  with its stream events, so recovery reaps an orphan by its claude session id and the kill path marks it killed.
  The terminal view leaves conductor sessions out of its worker rows and start/end lines.
- **`--mcp-config` takes a file path now.** `PrintOptions.mcpConfig` (inline JSON) became `mcpConfigFile`, because
  inline JSON would put the bearer token in argv, visible to `ps`. The file is written with mode 600 (temp file plus
  rename).
- **Conversations.** The claude session id is stored in `conductor_sessions` on the first `init` line of a fresh
  conversation; later processes (after the 10-minute idle stop, a model switch, or a mastermind restart) use
  `--resume <id>`. A process that exits before any `init` without mastermind ending it was refused by the CLI (id in
  use, conversation not found), so that conversation is ended and the next turn starts a fresh one rather than
  failing forever. Context tokens (last assistant line's input plus cache tokens) are stored per turn for M8's
  rollover. If the `mastermind` MCP server isn't `connected` in `init`, the turn fails with
  `ConductorToolsUnavailableError` and the process is stopped.
- **Turns.** `sendChat` stores the user message and returns `{ turnId, message }` at once; the reply arrives on
  the bus. A message sent while a turn runs joins it (same turnId, written raw to stdin). Replays are counted, and a
  message the CLI didn't fold in before the `result` gets a follow-up turn. A message sent after Stop, while the
  stopped turn is still ending, is held and starts the next turn, because an interrupted CLI may drop queued input.
  Stop is a `control_request` interrupt; if no result follows within 10 s the process is stopped. A stopped turn
  keeps its streamed text, including a block cut short, as a `conductor` message with `meta: { stopped: true }`.
- **Messages per turn.** Each turn stores the `user` message, a `conductor` message (text blocks joined as
  paragraphs, and the streamed deltas carry the same `\n\n`), then one `action` line, then a `system` line if the
  turn failed. Proposal and plan messages made by tools during a turn carry its turn id and conductor session
  (`postConductorMessage` with the runner's `activeTurn`); the owner's decisions don't. Error results are classified
  like worker runs: a usage limit also reports the global back-off; auth expiry only posts a line (the auth flow is
  M8).
- **Action line.** Each action tool in `tools.ts` gained `done(input)`, a past-tense phrase next to `describe`. The
  line joins the distinct phrases of the turn's successful, ungated mastermind tool calls: `✓ Added 2 tasks, held a
  and paused all work`. Read tools, failed calls and `awaiting_confirmation` results are left out (the proposal box
  shows those). The plan's example "and started 2" isn't produced: tasks start asynchronously after the turn, so the
  count would be a guess.
- **Turn prompt.** `<state>` (the digest), then `<updates>` (system messages since the previous turn's prompt, at
  most 20: event lines, proposal decisions, failures), a blank line, then the owner's text. The prompt tells the
  model these blocks come from mastermind and must never be mentioned.
- **Digest.** Five short lines: time, counts by status, workers and running sessions (id, role, attempt,
  minutes), what needs the owner (review, blocked, pending decisions as their questions), and the scheduler state
  (sign-in, paused, usage limit with time) plus up next. Lists are cut by character budget with "and N more", ids
  are never truncated (a truncated id is ambiguous), and the worst case measured is about 255 tokens.
- **Event lines** come from bus transitions: a task entering `review`, `blocked` or `done` (done is only reached by
  rebasing), `authRequired` turning true, and a new `resumeAt`. Content has no time (the message's `ts` carries it);
  the usage limit line names the local resume time. `meta` is `EventLineMeta` (`{ event, taskId | resumeAt }`).
- **HTTP and bus.** `GET /api/chat?after=` returns `{ model, replying, messages }`; `POST /api/chat` is `sendChat`
  (`{ text, model? }`; a different model is saved to `models.conductor` in `.mastermind/config.yaml` and the live
  process is restarted with `--resume` on the next turn); `POST /api/chat/stop` is `stopChat`. A new bus event
  `chat.turn { turnId, replying }` marks a turn's start and end, so the UI and `mastermind chat` know when to switch
  Stop back to Send even when a turn produced no text.
- **fake-claude.** The `text` step takes `streamMs`, which paces its partial deltas and can be interrupted midway.
  It already read `--mcp-config` and called MCP tools over HTTP, so the conductor tests use `mcp` steps against the
  real server.
- **Review.** The action line counts only tool calls that got a result, so a call cut short by Stop isn't
  reported as done. A conversation is forgotten only when the CLI refused it outright (no `init`, no `result`, a
  plain failure); a sign-in or usage-limit exit keeps it for `--resume`. When the tools are unreachable, the
  process is ended before the turn fails, so a held message never goes to the dying process.

## m2-cli-client

- **Where it lives.** `packages/cli/src/client/`: `instance.ts` (find the running instance), `api.ts` (HTTP client),
  `stream.ts` (WebSocket client), `chat.ts`, `logs.ts`, `format.ts` (human output), `output.ts` and `commands.ts`,
  which registers the subcommands on the commander program. Core gained `findRunningInstance(stateDir)` in
  `lock.ts`: `none` (no lock, an unreadable one, or a dead pid), `starting` (no port or token yet) or `running` with
  port and token. The client always talks to `127.0.0.1:<port>` with the bearer token, like the web app.
- **Which repo.** Client commands find the repo from the current directory (`git rev-parse --show-toplevel`, so a
  subdirectory works) or from `--repo <path>`, an addition to 14.3 for scripts and tests. Without a live instance
  they exit 1 with `mastermind is not running for <repo>. Start it with \`mastermind .\` in that repo.`; every
  error goes to stderr with exit 1, and multi-issue API errors print one issue per line.
- **Task controls are generated** from `actionRoutes`: every action routed as `POST /api/tasks/:taskId/<its own
  name>` becomes `mastermind <name> <task>`. Today that is hold, release and retry; discard and approve appear as
  soon as M5 registers actions named `discard` and `approve` on `/api/tasks/:taskId/{discard,approve}` (14.1).
  Help texts for all five are written already. The result is validated as a `Task`; if M5's results differ, the
  command needs its own schema.
- **chat** opens the WebSocket before `POST /api/chat`, buffers events until the turn id is known, then prints the
  turn's `chat.delta` text as it streams, the rest of the stored reply if deltas were missed, then the action,
  proposal, plan and system lines (proposals and plans with a hint to decide in the web app, since 14.3 has no
  confirm command). It ends on `chat.turn` with `replying: false`, which the runner emits after storing the turn's
  messages. Exit 1 if the turn posted a `system` (failure) message or mastermind stopped mid-turn. `--json` prints
  `{ turnId, messages }` at the end instead of streaming.
- **logs** prints every session of the task (oldest first) with its events and an `ended <status>` line, or
  `No sessions yet for <task>.`
  `-f` opens the stream before reading the history and de-duplicates by event id per session, so nothing is lost
  or doubled in between; it ends with exit 0 on `service.stopping` and exit 1 if the connection drops. `--json`
  prints one `SessionEvent` per line.
- **import/export** use the `importTasks` and `exportTasks` routes. `export -` writes the YAML to stdout
  (`{ yaml }` with `--json`).
- **Output.** `status` is a label/value block (counts by status, workers, running sessions with elapsed time, up
  next, blocked, rebasing when non-empty, scheduler state); `tasks` is a table with `pending (held)` for held tasks.
  `--json` prints the validated API response.
- **Tests.** `test/e2e/cli-client.test.ts` runs the built binary against a live instance per test (fake-claude
  Conductor and workers; tasks, holds and a past session seeded in SQLite before start). The `logs -f` test waits
  for the seeded history to print (so the stream is already open), then releases the task and sees the new
  worker's events arrive. `packages/cli/src/client/chat.test.ts` is a table for the turn follower.

## m2-verify

- **Done-when test.** `test/e2e/m2-chat.test.ts` runs the built binary with a fake-claude Conductor and fake workers.
  `mastermind chat "add a task to create hello.txt"` makes a `create_tasks` call, and the test waits until a worker
  session for the new task is running and has spoken. Then it asks `mastermind chat "what's running?"`. The fake
  Conductor's answer depends on the state it was given: its scenario turn only matches when the `<state>` digest in
  the prompt lists `hello` as a running worker, and otherwise a fallback answers "Nothing is running." So the scripted
  answer passes only if mastermind fed the real state into the turn. The test also checks the tool calls
  (`create_tasks`, then `list_sessions`) and that one persistent Conductor process served both turns.
- **Shared helpers.** `test/support/mastermind.ts` has `startMastermind` (start a binary and wait for the web app
  link, with a choice of launcher), `openProjectDb` and `conductorToolCalls`. `conductorToolCalls` reads tool names
  from the stored stream lines of every conductor session with the production stream parser. `cli-client.test.ts` and
  `m1-runtime.test.ts` now use these helpers instead of their own copies.
- **Live test.** `pnpm test:live` (vitest project `live`, only defined when `MASTERMIND_LIVE=1`, so verify and CI
  never see it) runs `test/live/conductor.live.test.ts`. It runs the CLI from source through tsx, so it always uses
  the current `prompts/conductor.md` without a rebuild. A temp `claude` wrapper on PATH sends `auth …`, `--version`
  and any run whose `--append-system-prompt-file` is `conductor.md` to the real CLI. Every other run (the workers)
  goes to fake-claude. It uses the real HOME, because the real CLI needs the owner's sign-in. The repo's
  `mastermind.yaml` points `worktreeDir` at a temp dir, so nothing is written under `~/.mastermind`. The test asserts
  on tool calls only: the first turn includes `create_tasks`, and the status turn makes no calls outside Read, Grep,
  Glob and the read tools of 6.3. The Conductor uses the configured default model (opus). Before running it from
  inside Claude Code, unset the nested-session variables listed in `docs/claude-cli-notes.md`.
- **Defect fixed: the real Conductor could not reply at all.** On the first live run, every turn failed with `API
  Error: 400 tools.15.custom.input_schema: JSON schema is invalid`. The model-name pattern `^[\w.[\]-]+$` reaches the
  API inside `set_config`'s JSON schema, and the API's validator reads the `[` inside the class as the start of a
  nested class. The pattern is now `^(?:[\w.\]-]|\[)+$`, which accepts the same names, including ids such as
  `claude-sonnet-5[1m]`. Escaping `[` inside the class would also work, but ESLint's `no-useless-escape` rejects it.
  The fake-claude tests could not catch this, because fake-claude never validates tool schemas.
- **Live outcome (2026-10-06, Claude Code 2.1.283, Max, opus).** After the fix it passed on all three runs, the last
  one with the revised prompt. "add a task to create hello.txt" made exactly one `create_tasks` call (task
  `hello-txt`, acceptance `test -f hello.txt`, touches `hello.txt`). "what's running?" made no tool calls and answered
  correctly from the digest ("hello-txt is running. It's on its first attempt…"). The prompt gained two small changes:
  - The old rule "use the read tools before you answer" conflicted with the fresh `<state>` block, so the prompt now
    says to answer from the state block when it covers the question and to use the read tools for anything it doesn't.
  - Replies after a change may be one or two sentences, without guessing what mastermind will do next. Replies after
    creating a task are still three or four sentences; further tuning was left for M3, when the chat UI shows them.

## m3-web-shell

- **Layout.** `packages/web/src/`: `api/` (`token.ts`, `client.ts`), `store/` (`state.ts`, `reducer.ts`, `store.ts`,
  `hooks.tsx`, `status.ts`), `live/connection.ts`, `components/` (top bar, status link, Pause, banners), `screens/`
  (`Screen`, a titled placeholder each route uses until its own task replaces it; Settings stays a bare heading
  until M8) and `theme/` (`tokens.css` holds the 15.1 values verbatim as CSS variables, `base.css`, `shell.css`).
  `testing/fixtures.ts` builds contract objects for the web tests.
- **Router.** `react-router` 8 in declarative mode (`BrowserRouter`), path routes `/`, `/overview`, `/tasks`,
  `/sessions`, `/review`, `/settings`, anything else redirects to `/`. Path routing, not hash routing, because the
  fragment carries the token; the server already falls back to `index.html` for unknown GETs. Active tabs get
  `aria-current="page"`, a bold label and an underline, not only a colour.
- **Fonts.** `@fontsource/ibm-plex-sans` (400, 500, 600) and `@fontsource/ibm-plex-mono` (400, 500), bundled by Vite
  into `dist/assets`, so the app needs no network.
- **Store: hand-written, no library.** One `createStore` (getState, dispatch, subscribe) over a pure
  `reduce(state, action)`, where an action is any `BusEvent` plus `snapshot.loaded`, `connection.changed` and
  `flags.changed`. State is normalised (tasks by id, sessions by id, session events, checks by task then id, rebases,
  terminals, proposals, chat). Reducers copy only the path they change, so every untouched entity keeps its
  reference. `useLive(selector)` is `useSyncExternalStore`, and `useTask(taskId)` / `useSession(sessionId)` select a
  single entity, so a pane re-renders only when its own task or session changes (`store/hooks.test.tsx` proves it).
  Selectors must return stored values, never build new objects. Zustand or Redux would add a dependency for the same
  twenty lines.
- **Reducer rules worth knowing.** `task.updated` is ignored when the stored task has a newer `updatedAt`;
  `session.started` never reopens a session already known; session events and chat messages are de-duplicated by id
  and kept in id order; `chat.delta` builds a per-turn draft that the turn's `conductor` message or `chat.turn
  replying:false` removes; `config.updated` only feeds the chat model today; terminal output keeps the last 200 000
  characters. The tasks read is parsed with `taskSchema`, so `unblocks` is dropped and later screens derive it from
  deps (an event never carries it, so storing it would go stale).
- **Live connection** (`connectLive`). Each attempt first reads `GET /api/instance` (new: project name and account,
  `instanceInfoSchema`), because a browser reports a refused WebSocket upgrade as a bare close and a wrong token would
  otherwise look like a stopped server: a 401 there shows "No access … open the link printed in the terminal" and
  stops retrying. Then the socket opens; once it is open the snapshot (summary, tasks, sessions since local midnight,
  chat) loads, and stream events that arrived meanwhile are held and applied after it. An unexpected close retries
  after 250 ms, 0.5, 1, 2 and 4 s; when all fail the page shows the stopped banner (about 8 s after a hard kill).
  `service.stopping` shows it at once. Unexpected stream messages are logged to the console and skipped. A snapshot
  that fails after its socket already closed is ignored, so it can't start a second retry or close the next socket.
  A snapshot after a reconnect keeps the stored object of every task and session that didn't change, so only panes
  whose entity changed re-render. `live/connection.test.ts` covers these paths with a fake socket and stubbed fetch.
- **Top bar.** Project name, tabs, the status link and Pause/Resume. The status word is Running, Paused, Usage
  limit, Sign-in needed, Connecting, Reconnecting, Stopped or No access, with `· Max` (or Pro) once known and a dot
  whose colour only repeats the word. The status links to `/settings` (15.2 item 9) and has a real tooltip
  (`role="tooltip"`, `aria-describedby`, shown on hover and focus) with the account and "Ctrl+C twice in the terminal
  stops mastermind and every session it started." Pause posts `pause`/`resume` and applies the returned flags; a
  failure shows next to the button.
- **Banners.** Sign-in needed uses 4.3's wording; usage limit shows the local resume time (with a weekday when it is
  not today); stopped is 3.4's sentence. While stopped or without access, only that banner shows.
- **Contracts.** `planLabel` moved from `auth.ts` to `contracts/config.ts` so the browser can use it.
  `actionInputSchemas` maps every action to its input schema and `ActionInputs` is derived from it; the web client's
  `act(name, input)` is typed by it, and `ContractedActions` now requires each action definition to use exactly that
  schema, so the contract can't drift from core. `actionResultSchemas` (checked against `ActionResults` with
  `satisfies`) lets the web client validate every action result; `accessTokenSchema` (64 hex characters) validates the fragment and the stored token. `ApiServerOptions` and
  `ReadSources` gained `instance`.
- **Dev server.** `pnpm --filter @mastermind/web dev` proxies `/api` (HTTP and the WebSocket) to
  `MASTERMIND_URL`, default `http://127.0.0.1:4700`. Open `http://localhost:5173/#t=<token>` with the running
  instance's token; Host and Origin are `localhost`, which the server accepts.
- **Playwright harness.** `test/e2e/web/harness.ts` is a `mastermind` fixture: a temp repo on branch `dev`, an
  isolated HOME with fake-claude, the built binary started through `test/support/mastermind.ts`, and the printed link
  opened in the page. Cleanup runs the shared `runCleanups` after each test. `global-setup.ts` runs the fake-claude
  PATH guard and fails early if `pnpm build` hasn't produced `packages/cli/dist` with the web app. The stopped banner
  is tested for SIGTERM (the `service.stopping` frame) and SIGKILL (no frame, reconnects fail).

## m3-chat

- **Where it lives.** `packages/web/src/screens/ChatScreen.tsx` composes the screen from `src/chat/`: `entries.ts`
  (pure: chat messages, drafts and proposals become display entries; first-run and setup checks), `progress.ts`
  (the status pill text), `mentions.ts` (`@task` completion), `models.ts`, `use-send.ts`, `use-request.ts`, and one
  component per element (`Transcript`, `Reply`, `DecisionBox`, `PlanList`, `EventLine`, `Composer`, `ModelMenu`,
  `StatusPill`, `FirstRun`, `SetupQuestion`). Styles are in `theme/chat.css`; `base.css` gained `button.primary`,
  form control styling and `.visually-hidden`.
- **Message styles.** `user` is a right-aligned bubble (plain text). `conductor` is markdown through `react-markdown`
  with `skipHtml`, so raw HTML is dropped and unsafe URLs are stripped by its default URL transform; links open in a
  new tab. Markdown images render as links, so a reply can never make the browser fetch a URL on its own. A stopped reply gets a muted "Stopped". `action` is the muted line under the reply. Every `system`
  message (6.4 event lines, proposal outcomes, turn failures, the setup confirmation) is a centred line with the local
  time. Streamed drafts render after the stored messages and disappear when the turn's reply is stored.
- **Decision box.** The button label is the first word of the question, because each question is the tool's
  imperative `describe` phrase ("Rebase sched-prio onto main?" → **Rebase**; set_config → **Change**). The second
  button is **Not now**. "See changes" links to `/review?task=<id>` only when the proposal names a task: the gate
  copies a `taskId` arg into the proposal message's meta (`proposalMetaSchema.taskId`), so the link survives a
  reload. The status comes from the live proposal, else from the decision's
  `system` message meta, else pending, so a reload still shows decided boxes as decided.
- **Status pill.** `N working · N needs you · N of M done`: working is running, checking and rebasing; needs you is
  review, blocked and pending decisions in the chat. With no tasks and no decisions it reads "No tasks yet".
- **Plans.** `planMetaSchema` gained `notes` (task id → note, default `{}`), so the list shows each note without
  parsing the message text; Start posts `meta.tasks` to `createTasks` unchanged and turns into "Started" once every
  planned task exists.
- **Model menu.** A native `<select>` labelled Model (Opus, Sonnet, Haiku, plus the configured model if it is
  something else). A change calls `setConfig({ models: { conductor } })` at once, so the choice persists per project
  even before the next message; the runner reads the model per turn.
- **Input.** Enter sends, Shift+Enter adds a newline, IME composition is respected. Typing `@` shows a listbox of
  matching task ids (arrow keys, Enter or Tab to accept, Escape to dismiss). `/pause` and `/resume` call the
  scheduler actions instead of chatting. Neither is advertised. A message sent while replying joins the turn; the
  button shows Stop while `chat.replying`.
- **First run** is "no owner message in the chat yet". It shows the heading, the setup question while no setup
  confirmation exists, and the three starters. "Plan work from a goal" prefills "Plan work from this goal: " and
  focuses the input; "Import tasks.yaml" opens a file picker and posts the file to `importTasks`, then reports the
  count and warnings; "What can you do?" sends that message.
- **Setup confirmation (new action `confirmSetup`, `POST /api/setup/confirm`).** Use these and Change → Save both
  call it with `{ build, test }`. It writes them through the same config writer as `setConfig`, emits
  `config.updated`, and posts a `system` message with `meta: { setup: "confirmed" }` (`setupMetaSchema`). The chat
  history therefore records that the question was answered (it survives restarts without a new table or flag), and
  the Conductor sees the confirmed commands in its next turn's updates. It is not an MCP tool.
- **Config read.** New `GET /api/config` returns the merged file-form `Config` (`apiResponseSchemas.config`);
  `ApiServerOptions`/`ReadSources` gained `config()`, and the runtime keeps the latest merged config for it. The web
  snapshot loads it and `config.updated` replaces it, so the setup question shows the detected commands (and
  Settings can use it in M8).
- **Connection fix.** A 401 after the page has been live now shows the stopped banner instead of "No access": each
  run has its own token, so a refusal then means the run stopped and something else answered on that port. This
  also fixed a Playwright flake where a parallel test's instance took the port of a SIGKILLed one.
- **Tests.** `chat/chat-screen.test.tsx` (Testing Library, new dev dependency): a streamed reply assembled from
  deltas and replaced by the stored reply plus action line; Enter vs Shift+Enter with the real API client over a
  stubbed fetch; `@task` completion and `/pause`; and no internal name (Conductor, MCP, tool or action names) in the
  rendered text or accessible attributes. `test/e2e/web/chat.spec.ts`: first run with a Makefile repo then Use these
  (and it stays answered after a reload); a streamed reply with Stop, markdown, the action line, the pill and model
  persistence; confirming a set_config decision box. The Playwright fixture gained `repoFiles` and `scenario`
  options and exposes `repoPath`.

## m3-overview-sessions

- **Where it lives.** `screens/OverviewScreen.tsx` and `screens/SessionsScreen.tsx` compose `src/overview/` (`board.ts`:
  count tiles, rebase queue, Needs you; `up-next.ts`; one component per panel and `SessionCard`) and `src/sessions/`
  (`activity.ts`, `duration.ts`, `session-list.ts`, `links.ts`, `use-session-events.ts`, `use-follow-scroll.ts`, and
  `SessionList`, `SessionHeader`, `Timeline`, `SessionFacts`, `StopSessionButton`, `FileChanges`, `FixerReason`,
  `Elapsed`). Styles are `theme/overview.css` and `theme/sessions.css`; `base.css` gained `.button-link`, `+`/`−`
  colours and themed `<progress>`/`<meter>`. `useRequest` moved from `chat/` to `components/` and `useNow` (a ticking
  clock) lives there too; only the small `Elapsed` component ticks, so screens don't re-render every second.
- **Up next is derived live, with the scheduler's own rules.** The pure readiness logic moved from `scheduler.ts` to
  `contracts/queue.ts` (`touchesOverlap`, `byPriority`, `taskQueue`), so core and the browser share it. `taskQueue`
  returns every pending task in start order with what it waits on (`held`, unmet `deps` with their statuses or
  `missing`, or the task whose `touches` it shares); a ready task claims its paths, so a lower-priority task sharing
  them waits on it, exactly as `pickReady` starts them (`pickReady` is now `taskQueue` filtered and sliced). The panel
  adds one line when paused, signed out or at the usage limit. `summary.upNext` is not used: it is only read with
  the snapshot and would go stale.
- **Tiles.** Remaining is `pending`; Running is `running`, `checking` and `rebasing` (work in flight); Done and
  Blocked are their statuses; "N of M done" counts all tasks. `review` is not a tile: it appears under Needs you, with
  blocked tasks and the chat's pending decisions (same count as the chat pill). Rebase queue is tasks in `rebasing`,
  oldest `updatedAt` first, as the summary read does. Links go to `/review?task=`, `/tasks?task=`, `/review?session=`
  (View diff) and `/sessions?session=` (Activity), for M4/M7 to honour.
- **Session history.** The snapshot carries no events, so `useSessionEvents` reads `GET
  /api/sessions/:id/events` (new `api.sessionEvents`) once per session and dispatches `session.history.loaded`, which
  merges by id with events already streamed in. `historyLoaded` records which sessions are loaded and is reset by
  every snapshot, so a reconnect re-reads any history it missed. No polling anywhere.
- **Activity from events (until M4's changes API).** `sessionActivity` parses each stored payload with
  `streamLineSchema` (cached per event object in a WeakMap): files and `+`/`−` come from Edit (`old_string`/`new_string`
  line counts), MultiEdit and Write (content lines) tool inputs, relative to the init line's cwd; commits count
  `commit` events; context is the last assistant line's input plus cache tokens, against 200k (1M for `[1m]` models).
  These are estimates: a Write over an existing file counts all its lines as added.
- **Fixer reason.** Sessions carry no reason, so a fixer card shows "Attempt N ·" a failed rebase ("Rebase
  conflict"), else the latest failed check ("Acceptance check failed: …"), else "Fixing failed checks". M5 may want a
  stored reason.
- **Sessions screen.** The selection is `?session=<id>`; without one it is the oldest active session, else the most
  recently finished. Lists leave out conductor sessions. Timeline rows are a table (time, type, summary); `error` rows
  are peach and keep the word `error`, and the last row of a running session is highlighted with a "now" tag and
  `aria-current`. Auto-scroll follows the bottom until the owner scrolls more than 24 px up; "Jump to latest" resumes.
  Stop session posts `stopSession` and applies the returned session at once (the `session.ended` event follows).
- **Tests.** `overview/overview.test.ts` (start order, every waiting reason, tiles, rebase queue, Needs you) and
  `sessions/sessions.test.ts` (elapsed with fixed clocks, activity from realistic payloads, grouping by local day,
  fixer reasons). `test/e2e/web/overview.spec.ts` creates a task over the API with a fake worker that writes, commits
  and then runs 60 paced commands: the card's branch, latest action and `hello.txt +2 −0`; the timeline growing,
  pausing on a wheel scroll up and resuming with Jump to latest; Stop session leaving the task held in Up next.
- **Fix: a timing-bound timeline test.** It waited for more than 30 rows with Playwright's default 5 s poll, while the
  fake worker needed about 5 s of scripted pacing to get there; right after the gate, under load, it fell short.
  The worker now adds rows for far longer than the test runs, and the test waits for the condition it actually
  needs (the first row scrolled out of view) with a 20 s timeout for waits that depend on the worker's pace. The
  Playwright harness attaches mastermind's stdout and stderr to a failed test.
- **Review fixes.** `SessionManager.stopSession` now resolves only after the stopped session is settled (status
  `stopped`, task held), so the `stopSession` action really returns the stopped session, as its description says;
  before, it returned the row while it was still `running`. `useSessionEvents` drops a history read that began
  before a disconnect, so it can't mark a session's history loaded with events missing from the gap.

## m3-verify

- **What it proves.** `test/e2e/web/m3.spec.ts` runs the built binary with a fake Conductor and fake workers. One
  test adds alpha, then beta, by chat; asks "what's running?" (the fake Conductor only answers when its digest lists
  both workers); watches them through the status pill, Overview cards and the Sessions timeline; then stops alpha by
  chat (`stop_session`) and sees the pill, Overview (alpha held in Up next) and Sessions (alpha Stopped, beta Running)
  follow. A random marker set on `window` at the start must still be there at the end, so nothing reloaded the page.
- **Session id in the scenario.** A fake Conductor can't read tool results, so the stop turn names session 2: the
  Conductor's process is the first session and alpha's worker the second, because beta is only added once alpha is
  running. The test asserts alpha's Activity link points at session 2 before relying on it.
- **Accessibility test.** Chat, Overview and Sessions (running and stopped) are driven by keyboard only: Tab to the
  Message box and Enter, Tab to the Overview tab, a card's Activity link and Stop session (Space), each with a visible
  focus outline (the Message box's ring is on its composer box, via `:focus-within`, so the check accepts an
  outlined ancestor). On every screen: every button role is a `<button>`, every link role an `<a href>`, the aria
  snapshot has no unnamed control, and every visible element painted (background, border or box-shadow) in frost or
  peach has text itself or beside it in its parent; the check also requires at least one painted element, so a
  theme change can't make it pass with nothing to inspect.
- **Typing browser code.** The Playwright specs run code in the page, so `test/e2e/web/` has its own tsconfig with
  the DOM lib; the root tsconfig excludes it, `pnpm typecheck` checks it and ESLint uses it. Node tests keep no DOM
  types.
- No defects were found in earlier work.

## m4-git-service

- **Where it lives.** `src/git/path-safety.ts` (`normalizeRelativePath`, `resolveInsideWorktree`, `pathInside`,
  `UnsafePathError` with a `reason`), `src/git/changes.ts` (`listChanges`, `readCommittedFile`, `readWorktreeFile`,
  `listTree`, `NotAFileError`), both exported from `@mastermind/core/git`. `src/task-files.ts` (`createTaskFiles`)
  maps a task to its clone and base or round commit and turns path errors into `ActionError`s; the read models
  include it, so `ReadSources` and `ApiServerOptions` gained `git`. Contracts are `contracts/changes.ts`.
- **Changes.** `git diff --name-status` and `--numstat` are two calls (given together, git prints only the
  name-status), both `-z --find-renames --no-ext-diff --no-textconv` against the from-commit, plus `git status
  --porcelain=v1 -z --untracked-files=all`. Each file is `{ path, oldPath, status: added | modified | deleted |
  renamed, additions, deletions, binary, uncommitted }`; counts are `null` for binary files. A path in `status`
  (either side of a rename) is `uncommitted`. Untracked files are `added`, with lines counted the way git does, a
  symlink as one line, and `null` counts above the size cap. Copies count as added, type changes and unmerged
  entries as modified. A delete plus an untracked file that the worker did not `git mv` shows as a delete and an
  add: rename detection only sees tracked files, and mastermind never writes the worker's index.
- **No index locks.** Every read runs `git --no-optional-locks`, because `status` and `diff` otherwise refresh the
  index opportunistically and could make a worker's own `git add` or `commit` fail on `index.lock`.
- **since.** `base` (default) or `round:N`, validated as a string so the MCP schema stays plain. `round:N` uses the
  `end_commit` of the latest session of round N that has one; none is a 404. The file route takes `since` too, so
  the base side of a file can be shown as of that round.
- **Files.** `GET /api/tasks/:taskId/file?path=&side=base|current&since=` returns `{ path, side, kind }` with kind
  `text` (content, size), `binary` (size), `too_large` (size) or `missing`. The cap is 1 MiB (`maxFileBytes`), and a
  file is binary by git's own rule (a NUL in the first 8000 bytes). The base side reads `ls-tree --long` (type and
  size first, so nothing over the cap is read) then `cat-file blob` as bytes: `Git` gained `readBytes`, backed by a
  new `onStdoutBytes` handler in the process registry, because the line reader can't round-trip binary or a final
  newline. A symlink's base version is its target text, as git stores it.
- **Path safety.** A requested path is rejected (400, issue path `path`) if it is empty, contains NUL, is absolute,
  has a `..` segment (even one that climbs back in) or a `.git` segment in any case. The current side then
  realpaths the worktree and the file, and rejects a target outside the worktree or inside its `.git`. A path that
  doesn't exist, including a dangling symlink, is `missing` and nothing is read. The file is opened with
  `O_NOFOLLOW | O_NONBLOCK` and `fstat`ed, so a FIFO or directory is "not a file" (400) instead of hanging, and a last
  component swapped for a symlink after the check fails. An intermediate directory swapped between realpath and
  open is not caught; workers are sandboxed to the worktree, so this is accepted. The base side never touches the
  filesystem, so only the lexical checks apply there.
- **Tree.** `ls-files --cached --others --exclude-standard` minus `ls-files --deleted`, sorted, so deleted files
  drop out and ignored or excluded files (`.mastermind-result.md`) never appear.
- **Workspace errors.** No worktree or base commit yet, or the clone directory gone: 409. Unknown task: 404.
- **MCP.** `get_changes` (`{ taskId, since? }`) is a read tool returning the same JSON as the changes route.
- **Edit events carry the file path.** `session.event` has an optional `path` (worktree-relative) on edit events
  (Edit, MultiEdit, Write, NotebookEdit) inside the task's clone, matched against the spawn cwd and the `init` cwd.
  Because Claude Code prints the tool_use line *before* it applies the edit, a new bus event
  **`file.changed { sessionId, taskId, path }`** is emitted on the edit's successful tool_result, when the file on
  disk has really changed. The review screens should show "editing" from the first and refetch the file and
  changes on the second. The web reducer ignores `file.changed` for now; the terminal view does too.
- **Review.** Untracked files are line-counted in batches of 32 so build output can't exhaust file descriptors, and a
  file deleted between `git status` (or the path check) and the open is dropped from changes or reported `missing`.

## m4-review-ui

- **Where it lives.** `screens/ReviewScreen.tsx` composes `src/review/`: pure `file-list.ts` (directory groups,
  `M`/`A`/`D`/`R` markers, the editing tag, the default file), `selection.ts` (tabs and the chosen session),
  `problem.ts`, `location.ts`, `file-text.ts`; hooks `use-task-changes.ts`, `use-file-sides.ts`, `use-task-tree.ts`,
  `use-editing.ts`, `use-coalesced-load.ts`; and the components (`SessionTabs`, `ReviewToggles`, `FileList`,
  `FileView`, `FileContents`, `SessionReview`, `SessionGrid`, `SessionPane`, `DiffEditor`, `CodeEditor`). Styles are
  `theme/review.css`; the Monaco theme is `theme/monaco-theme.ts`.
- **URL state.** `/review?session=N&mode=file&file=path`, `?view=all` for the grid, and `?task=id` (Overview's
  links) picks that task's running session, else its latest. Without either it is the oldest running session, else
  the latest finished today. Tabs are the running task sessions plus the chosen one if it has finished. The toggles
  are `<button aria-pressed>` groups labelled Show (Diff/File) and Sessions (One/All).
- **Live refresh without polling.** The store gained `workspaces` (per task: a `revision`, and per path the revision
  of its last `file.changed`), `editing` (session → path from `session.event.path`, or `file.changed`) and `changes`
  (per task, the last changes read or why it failed, new action `changes.loaded`). `ReviewScreen` mounts one
  `ChangesLoaders` entry per task on screen, so each task's changes are read once however many tabs or panes show
  them. `file.changed`, a `commit` event
  and `session.ended` move the task's revision; the changes list is read again on each move and after every
  reconnect, and the open file when its own path moves or when its entry in the changes list changes (which also
  catches edits made by shell commands). Reads go through `useCoalescedLoad`: one read at a time, and triggers that
  arrive meanwhile collapse into one more read, so a burst of edits can't starve the view or land out of order.
  The file is refreshed on `file.changed` rather than on the `session.event` that names it, because that line is
  printed before Claude Code writes the file (see m4-git-service).
- **Editing tag.** The file named by the latest edit of a running session. After a reload the stream's paths are
  gone, so `lastEditedPath` in `sessions/activity.ts` reads it from the stored events, relative to the init cwd.
- **Monaco, bundled.** `monaco-editor` 0.57 directly rather than `@monaco-editor/react` (PLAN 17), whose loader
  fetches Monaco from a CDN by default; two small components own the editors instead. It is used through its ESM entry points: `editor/editor.api`,
  `features/register.all` (editor contributions, diff editor, codicons) and a chosen list of tokenizer-only
  languages in `monaco-languages.ts`. The JSON, CSS, HTML and TypeScript language services are left out: they need
  their own workers and would show diagnostics in a read-only view. Only `editor.worker` is bundled (Vite
  `?worker`). Monaco is lazy-loaded (`React.lazy`), so only the Review screens pay for its ~1 MB gzipped chunk;
  nothing is fetched from a CDN. The theme reads the Arctic CSS variables at load time, so `tokens.css` stays the
  only place the colours live; added/removed lines use the plan's line backgrounds and the gutter shows `+`/`−`.
- **Diff.** Side by side in the one-session view (inline when narrow), base commit on the left and the file on disk
  on the right, read-only, with `uncommitted`/`committed`/`unchanged` next to the path and `base abc1234 → on disk`.
  A renamed file's base side is read from its old path. Binary and oversized sides show a message instead.
- **All sessions.** A two-column grid (one column under 960 px) of running sessions. Each pane shows the latest
  edited file as a compact inline diff with unchanged regions folded, and **Open** goes to that session and file.
  A problem gives the pane a peach border and a `⚠` label with words: the latest event is an error, the rebase
  failed, or the latest run of some check failed (so a fixer's pane shows why it is fixing).
- **Tests.** `review/review.test.ts` (file groups, markers, editing tag, tree mode, default file, session problems,
  tab selection) and reducer cases for the new store state. `test/e2e/web/review.spec.ts` uses a fake worker that
  commits one file and then edits README.md every 600 ms: the edit appears in the diff with `uncommitted` and keeps
  advancing without a reload; File mode lists the full tree and opens a plain editor; All shows the pane and Open
  leads back to the diff.

## m4-steering

- **Where it lives.** `SessionManager.messageSession(sessionId, text)` in `sessions/manager.ts`, the
  `messageSession` action in `sessions/actions.ts` (route `POST /api/sessions/:sessionId/message`), the
  `message_session` tool in `conductor/tools.ts`, and `sessions/SessionMessageBox.tsx` on the Sessions screen.
  Contracts: `messageSessionInputSchema` (text trimmed, 1 to 20 000 characters) and `messageSessionResultSchema`
  (`{ delivery: "live" | "resumed", session }`, the session that received the message).
- **Live delivery** is a stdin write (`LiveSession.steer`), accepted only until the session's first `result` (stdin
  is closed there, PLAN 8.4). The `steer` event is the CLI's `isReplay` echo, as the CLI notes decided, so it
  appears when the worker really takes the message in; nothing is recorded at write time, which would show it twice.
- **Resume fallback.** A session that has ended (or is ending: its result is in but the process hasn't exited, in
  which case the call waits for it to settle) is resumed with `--resume <claude_session_id>` in the task's clone,
  with the message as the prompt. The new worker row keeps the steered session's `attempt` and the task's round,
  and the task's `attempts` is unchanged; how the resumed run ends is settled like any worker run. The message is
  stored as a `steer` event on the new session before it starts (the CLI's replay of a turn's own prompt is not
  stored). The resume is refused with a 409 when it can't work or would collide: the conversation never got going,
  the session isn't the task's latest worker/fixer conversation (the error names the latest session), the task is
  `running` with another conversation, `rebasing`, `blocked` or `done`, the clone is gone, sign-in is needed, or a
  usage-limit back-off is active. `pending` (including held), `checking` and `review` resume; the start bypasses
  the scheduler (an explicit owner instruction, like a request-changes resume) and so is allowed while paused.
- **Continuations.** A message to a session whose conversation has continued in a live session of the same task
  (same claude session id) goes to that live session. Messages are handled one at a time, so two quick messages to
  an ended session give one resume and one live steer, not two resumes.
- **Messages the CLI never took in.** A message written to stdin but not echoed by the time the process exits
  (it arrived as the turn ended) is redelivered by resuming, once the run has settled. If that resume is refused,
  an `error` event `Message not delivered: <reason>` goes on the original session. Only runs that exited on their own
  redeliver: a stopped session drops them, and so does one mastermind aborted (a wrong permission mode would abort
  the resume too and count another attempt).
- **Action line.** `ActionTool.done(input, result)` now receives the tool's parsed result, so `message_session`
  reads `✓ Sent to <task>` from the session in the result.
- **Shared helpers.** The "conversation got going" rule moved from `recovery.ts` to `sessions/conversation.ts`
  (`canResumeConversation`), used by recovery and steering. `isEditingRole` (worker or fixer) lives in the
  browser-safe `contracts/sessions.ts`, so the Sessions screen shows the box by the same rule the server applies.
- **fake-claude.** `crash` takes `afterMs`: the process dies that long into the step, so stdin messages written
  meanwhile are never taken in (the fake hands queued messages over only between steps, like a tool boundary).
- **Web.** The box sits under the timeline of worker and fixer sessions. Enter sends, Shift+Enter adds a newline.
  For an ended session a hint says sending resumes it; after a resume the screen selects the new session. The
  Conductor prompt gained a short "Steering work" section.
- **Tests.** `test/integration/sessions/steering.test.ts`: a fake worker that waits on stdin writes a different
  file after an injected message; an ended session is resumed (argv, cwd, prompt, attempt, steer event, committed
  file); a message the worker never took in (it crashes mid-step) being redelivered and, under the crash's back-off,
  refused with a `Message not delivered` error; refusals; and the chat tool plus the HTTP route against a stand-in manager (the conductor harness gained a
  `messageSession` option). `packages/web/src/sessions/message-box.test.tsx` covers the box.
- **Fix: ambiguous chat box lookups in Playwright.** `getByRole("textbox", { name: "Message" })` matches
  substrings in Playwright, so right after a click to Chat, m3.spec's `say` found the Sessions screen's "Message
  this session" box (still mounted for a moment) and steered alpha instead of chatting. The chat specs now pass
  `exact: true`.

## m4-verify

- **What it proves.** `test/e2e/web/m4.spec.ts` adds a task through the web chat (fake Conductor `create_tasks`),
  opens its diff from the Overview card's View diff, and watches a fake worker's uncommitted edits to README.md
  arrive in the diff within 5 seconds and keep advancing, while the clone's HEAD is still the base commit. Every edit
  is a shell command (`printf … > README.md`), which the Edit-tool path of `review.spec.ts` did not cover.
  `test/e2e/m4-steering.test.ts` runs `mastermind chat` twice against the built binary: the first adds a task, the
  second makes the fake Conductor call `message_session`. The live worker, waiting on stdin, takes the message in
  and writes `greeting.test.txt` instead of `greeting.txt`. The test checks the `steer` event, the stdin message in
  fake-claude's log, a single still-running session (so delivery was live, not a resume) and the tool calls.
- **Session id in the scenario.** As in m3-verify, the fake Conductor names the worker as session 2 (the Conductor is
  session 1), and the test checks that before steering.
- **Defect fixed: shell edits never reached the diff.** The Review screens re-read changes only on `file.changed`
  (Edit-tool results), commits and session ends, so a file changed by a Bash command (a formatter, `sed -i`, a code
  generator) stayed stale until the next one of those. The spawner now emits a new bus event
  **`workspace.changed { sessionId, taskId }`** on every Bash tool_result, failed or not, since a failing command can
  still write files. The web store's `Workspace` gained `anyFile` (the revision of the last change that could have
  touched any file): the changes list is re-read on it, and the open file is read again when either its own
  revision or `anyFile` moves, because the changes entry alone can stay identical (`+1 −1` before and after). The
  terminal view and CLI clients ignore the event. Background shells (`run_in_background`) that write later are still
  only seen at the next trigger.

## m5-checks

- **Where it lives.** `@mastermind/core/checks` (`src/checks/`, a new package export): `runner.ts` (a `checks` row
  with its log, processes spawned as kind `check`), `rebase.ts`, `judge.ts`, `reviewer.ts`, `prompts.ts` (fixer,
  judge and reviewer messages), `outcome.ts` (pure: attempts and where a passing task goes), `pipeline.ts`,
  `actions.ts` (`rerunChecks`) and `log.ts` (log tails). `runSetupCheck` now uses the same runner. Sessions gained
  `one-shot.ts` (judge and reviewer calls), `effects.ts` (usage-limit, sign-in and back-off effects shared by every
  role) and `SessionManager.startFixer`. System prompts are `prompts/fixer.md` and `prompts/reviewer.md`.
- **Trigger and queue.** The pipeline subscribes to the bus and queues a task whenever it *enters* `checking`
  (a worker or fixer that succeeded, a re-run), plus every task already in `checking` on `start()`, which covers
  recovery's leftovers. One pipeline runs at a time (FIFO); a task is never queued twice. Each run first aborts a
  rebase left in progress in the clone (a killed run or a fixer that gave up), then runs build (skipped when
  `commands.build` is empty), acceptance, rebase, suite (skipped when `commands.test` is empty) and the reviewer.
  If the task leaves `checking` meanwhile (a steering resume), the run stops before its next step, its outcome is
  dropped, and a return to `checking` queues a fresh run. A run that throws (a failed fetch, a spawn error) blocks
  the task with the error as its reason instead of leaving it in `checking`.
- **Logs.** `.mastermind/logs/checks/<task>-<kind>-<time>.log`. The rebase log has the fetch, git's own rebase
  output and the conflicted files; the reviewer's log lists its findings.
- **Attempts.** A failed build, acceptance or suite check, or serious findings, count an attempt: with attempts
  left a fixer starts with attempt number `attempts + 1`, otherwise the task is `blocked` and an `error` event
  `Blocked after N attempts: <reason>` goes on its latest worker or fixer session (the timeline, the terminal and
  the chat's blocked line all see it). A fixer that ends `succeeded` returns the task to `checking`; any other end
  is settled like a worker run (8.4 rules).
- **Rebase conflicts.** Mastermind fetches main, rebases with hooks off and, on a conflict, aborts and starts a
  fixer with the log tail and instructions to redo `git rebase upstream/<main>`; no attempt is counted. "The fixer
  gave up" is a conflict again in the very next run after that conflict fixer (tracked in memory by its session
  id; a restart in between gives one more free fixer). That conflict counts an attempt. After a successful rebase
  the task's `base_commit` becomes the upstream commit, so the Review diff shows only the task's own changes.
  (Round `end_commit`s from before a rebase still point at the old commits.)
- **Flaky judge.** The first failed command check of a run goes to the judge (`models.judge`, `--max-turns 1`,
  `--tools ""`, `--json-schema {flaky, reason}`, prompt as stdin text). Flaky means one re-run that counts nothing,
  noted at the top of the re-run's log; only one re-run per pipeline run. A judge that gives no answer means not
  flaky.
- **Reviewer.** `models.reviewer`, `--tools Read Grep Glob` (also allowed), `--permission-prompts none`, the task,
  the changed files and the diff against upstream main (first 100 000 characters) on stdin, and a JSON schema
  `{findings: [{file, line|null, text, severity}]}`; a top-level array isn't possible because structured output is a
  tool input object. Every finding is stored with the round. The check fails only on a serious finding. Reviews are
  serialised inside the reviewer as well, so at most one runs even if something else asks. **A reviewer that gives
  no answer** (bad output, a crash) fails its check with the reason and the task proceeds: findings are advisory and
  a broken reviewer must not block work or loop.
- **Judge and reviewer sessions** have `sessions` rows (roles `judge`, `reviewer`, `attempt` null) with their
  events and `--session-id`, so recovery can reap them, plus `--no-session-persistence`. The spawner learned
  `inputFormat: "text"` (prompt written to stdin, then closed) and reports the `result` event. Their usage-limit,
  sign-in and unrecognised failures have the same global effects as a worker's.
- **Waiting instead of spending.** Judge, reviewer and fixer calls only start while work isn't paused, signed out or
  backing off. Otherwise the task stays in `checking`, parked, and its whole pipeline runs again on the next
  `scheduler.updated` or `auth.updated` that opens the gate (checks are cheap and deterministic compared with
  remembering a half-run pipeline).
- **Deviation: fixers start outside `maxWorkers`.** A fixer starts as soon as a check fails (9.2 "without
  waiting"), even if the scheduler has meanwhile filled the slot its worker left; the scheduler counts it, so no new
  worker starts until the count drops again. Making fixers wait for a slot would need a reserved-slot queue in the
  scheduler.
- **Passing.** `rebasing`, or `review` when `autoRebase` is off or when the task's declared touches *or* any file it
  actually changed (vs upstream main) overlaps `requireReviewFor`, by the scheduler's segment-prefix rule. Nothing
  takes tasks out of `rebasing` until m5-rebase-queue.
- **Routes and tools.** `GET /api/tasks/:taskId/checks`, `GET /api/checks/:checkId/log` (`{check, text,
  truncated}`, the last 1 MiB), `POST /api/tasks/:taskId/checks/rerun` (action `rerunChecks`: a `review` task goes
  back to `checking`; a parked `checking` task is queued; anything else, or checks already running, is a 409). MCP
  `get_check_log {taskId, checkId?, lines = 100}` returns the latest failed check's log (else the latest check)
  when no id is given. `rerunChecks` is not an MCP tool.
- **Tests.** `test/integration/checks/pipeline.test.ts` runs real workers, fixers, judges and reviewers from
  fake-claude against a temp repo whose Makefile build fails while `BROKEN` (or, once, `FLAKY`) is present: a
  fixed build, blocking at `maxAttempts`, a flaky re-run, a conflict a fixer resolves with a real `git rebase`, a
  serious then a minor finding, and a protected path held for review and re-run through the action.
  `routes.test.ts` covers the HTTP routes and the MCP tool; `checks/outcome.test.ts` the pure decisions.
  `m1-runtime.test.ts` now follows tasks to `rebasing` (with the reviewer off), since `checking` is no longer final.

## m5-rebase-queue

- **Where it lives.** `@mastermind/core/attribution` (`src/attribution.ts`: `findAttribution`, `stripAttribution`)
  and `@mastermind/core/rebase` (`src/rebase/`: `queue.ts`, `squash.ts`, `main-ref.ts` for the owner's repo,
  `actions.ts` for `approve` and `discard`). The fixer start and blocking logic moved out of the checks pipeline
  into `checks/fixing.ts` (`createFixerLauncher`, `checkFailureRequest`, `conflictRequest`). **One launcher is
  shared** by the pipeline and the queue (both take `launcher` in their options), so "the conflict fixer gave up"
  is noticed whichever of the two hits the conflict next. `claudeCallsAllowed` is in `sessions/effects.ts`.
- **Queue run.** One task at a time, FIFO, queued when a task *enters* `rebasing` and for every `rebasing` task on
  `start()` (recovery leftovers). Each run is a `rebases` row (`running`, then `succeeded` or `failed`, with
  `rebase.updated`) and a log `.mastermind/logs/rebases/<task>-<time>.log`. A row left `running` by a shutdown
  mid-run is marked `failed` when the task's next run starts, and a run that ends after `stop()` writes nothing. Steps: abort a leftover rebase, rebase
  onto main (the checks' `rebaseOntoMain`, so it is also a `rebase` check row), squash, build and test (as `build`
  and `suite` check rows of the round, no flaky judge), fetch into `refs/mastermind/<id>`, attribution guard,
  `update-ref refs/heads/<main> <new> <upstream>`. Then one transaction marks the task `done` and the row
  `succeeded`, `main.moved` and `task.updated` are emitted (which wakes the scheduler), and the ref and clone are
  deleted. Marking done before the cleanup means a crash leaves at worst a stray clone, never a task stuck in
  `rebasing` for work already on main. The task keeps its `worktree` path as history.
- **Main moved meanwhile.** A failed `update-ref` whose main is no longer the upstream we rebased onto restarts the
  run from the rebase (logged as "main moved … rebasing again"), up to 5 times, then blocks. Any other `update-ref`
  failure is an error, which blocks the task with the reason.
- **Squash message.** Subject is the task title (attribution stripped; `Task <id>` if nothing is left), then the
  stripped `.mastermind-result.md`, then `Task id: <id>`. "Task id" contains a space, so git does not parse it as a
  trailer and the commit has **no trailers at all** (the tests check `%(trailers)` is empty). Committed with hooks
  off, `--no-verify` and `--cleanup=whitespace`, under the clone's copy of the owner's identity. A branch that adds
  nothing to main after the rebase is marked `done` without moving main.
- **Attribution.** Line patterns, case-insensitive: any `…-by:` trailer naming Claude or Anthropic,
  `Generated with|by|using [Claude…`, `Claude-…session…:` trailers (the key must contain "session", so a subject
  such as `claude-cli: parse flags` survives), `claude.ai/code` session links and
  `noreply@anthropic.com`. The rewriter drops matching lines and collapses the blank lines left behind. A human
  co-author called Claude would be stripped too; that false positive is accepted. The guard scans
  `git log <upstream>..refs/mastermind/<id> --format=%B` in the owner's repo, which is exactly what main would
  receive; a match deletes the ref, fails the rebase row and blocks the task.
- **Owner on main.** Before rebasing and again right before `update-ref`, the queue checks `git worktree list
  --porcelain` for `refs/heads/<main>`, so a linked worktree on main counts too. While it is checked out the queue
  polls every 2 s (`checkoutPollMs`), emits a new bus event **`checkout.updated { branch, onMain }`** on each
  change, and the chat gets a system line (new event-line kind `owner_on_main`). The terminal view shows a standing
  peach notice (`StatusSnapshot.ownerOnMain`) plus an event line. A second new event, **`main.moved { branch,
  commit }`**, refreshes the terminal header's `main @ <sha>`. The web reducer ignores both for now.
- **Conflicts and failures** start a fixer through the launcher (`rebasing → running`), like the pipeline: a conflict
  counts no attempt unless the previous fixer was a conflict fixer that gave up; a build or test failure counts one.
  When Claude calls aren't allowed (paused, signed out, backing off), the fix request is kept in memory and
  launched on the next `scheduler.updated` or `auth.updated` that opens the gate; after a restart the task is
  simply rebased again.
- **Staying current.** The checks pipeline listens for `main.moved` (and checks once on `start()`): every `review`
  task whose `baseCommit` isn't main's tip goes back to `checking` with scope `current`, which runs only the
  rebase, the suite and the reviewer (9.2's checks 3 to 5), then returns to `review` or `rebasing` by the usual
  rules. `rebasing` tasks don't need it: the queue rebases them itself. The same check runs whenever a task
  *enters* `review`, because main may have moved after its checks rebased it but before they finished.
- **Actions.** `approve` (`POST /api/tasks/:taskId/approve`) moves a `review` task to `rebasing`, refusing any other
  status (the transition table also allows `checking → rebasing`, which must not be reachable by hand).
  `discard` (`POST /api/tasks/:taskId/discard`) is allowed in `review` **and `blocked`** (a deviation from 7.2's
  diagram, which only shows review; throwing away a blocked attempt is the natural use). It renames the clone aside
  in the same tick as the status change, so a staying-current re-run or a new start can't touch it, then deletes it
  and `refs/mastermind/<id>`. The task returns to `pending` with attempts 0 and `worktree`, `branch`, `baseCommit`
  and `resumeSession` cleared, so the next start clones fresh from main. A stored clone outside `worktreeDir` is
  refused with a 409. MCP tools `approve_rebase` and `discard_task` are gated by the default `conductor.confirm`;
  their questions are "Rebase <id> onto main?" and "Discard the work on <id>?". The CLI's generated `approve` and
  `discard` subcommands now exist.
- **Tests.** `src/attribution.test.ts` (the scanner and rewriter table) and
  `test/integration/rebase/rebase-queue.test.ts`, which uses the checks harness (it now builds the shared launcher
  and the queue, takes `startRebaseQueue`, `repoFiles` and a `config` that may depend on the temp repo, and exposes
  `bus`). The tests cover: one squashed commit by the owner with no merges; a trailer and robot footer that never
  reach main; main moved by the suite run behind the queue's back, then retried; pausing while the owner is on
  main; a queue conflict resolved by a fixer; a review task kept current and then approved; and discard.

## m5-test-and-decide

- **Where it lives.** The screen is `screens/DecideScreen.tsx` at **`/review/decide/:taskId`** (`?file=` picks the
  open file), with its parts in `packages/web/src/decide/`: `checks.ts` and `task-state.ts` (pure: the round's
  checks, the latest failure, the headline and which decisions are open), `DecisionButton.tsx` (one button per
  action, calling it directly: the click is the confirmation), `DecideHeader`, `CheckList`, `FailedTest` and
  `DecideFiles` (the Review screen's `FileList` and `FileView` in diff mode). The Review tab stays highlighted on
  the sub-path (`NavLink end` is now only set for Chat). Overview's "is ready for review" link goes to the screen,
  and so does a decision's "See changes" when its task is in review; other tasks keep `/review?task=`. The Review
  screen lists every task in `review` under a "Ready for review" bar linking to it, since such a task has no
  running session and would otherwise only be reachable from Overview or the chat.
- **A route, not a Review mode.** The screen follows the task after the decision: the header reads "Ready for
  review · round N", then "Rebasing onto main · round N", "Rebased onto main", or "Waiting to start" after a
  discard, so the owner sees the outcome where they clicked. The diff is shown only while the task has a clone
  (`worktree` set and not `done`); otherwise a line says why.
- **Decisions.** Approve and rebase is enabled only in `review`; Discard branch in `review` and `blocked` (as the
  action allows); Re-run all only in `review`. Each returns the task, which is dispatched as `task.updated`.
- **Checks.** The list shows the latest check of each kind in the task's current round, in pipeline order. The
  "Failed test" box shows the round's most recent failed check with the last 60 lines of its log
  (`GET /api/checks/:id/log`), tagged "passed since" when a later check of the same kind passed (a fixer fixed
  it). The API client gained `checks(taskId)` and `checkLog(checkId)`; the store gained `checks.loaded`, which
  never turns a finished check back to running. Checks are read again on every `task.updated` and reconnect.
- **Small fixes on the way.** The changes list is now read again when the task's `baseCommit` changes (the checks
  rebase it onto a moved main), and the open file when the diff's base commit changes, so the Review screens no
  longer show a diff against the old base after a rebase.
- **Wording.** `src/wording.test.ts` parses every non-test web source with the TypeScript parser and fails on any
  string literal, template text or JSX text containing merge or land (any form, any case), plus `index.html`.
- **Tests.** `decide/decide.test.ts` (pure tables), `decide/decide-screen.test.tsx` (the log tail, Re-run all),
  a reducer case, and `test/e2e/web/decide.spec.ts`: a guarded task whose first draft fails acceptance (the judge
  is matched by `--max-turns`, since it has no system prompt file) reaches review with its fixed failure in the
  box; Approve and rebase puts one squashed commit on main; Discard branch (after Pause, so the task doesn't start
  again) deletes the clone and ref and leaves main alone. The web e2e harness exposes the temp repo's `git`.
- **m1 runtime test.** `test/e2e/m1-runtime.test.ts` waited for alpha and beta to sit in `rebasing`, which the
  rebase queue now leaves within milliseconds, so the poll could miss it. It now waits for all three tasks to be
  `done` and checks that gamma's worker started after both dependencies were done; the resume test likewise
  waits for `done`.

## m5-verify

- **What it proves.** `test/e2e/m5-rebase.test.ts` runs the built binary on a temp repo whose Makefile `build` and
  `test` targets are auto-detected, and adds tasks with the real `mastermind import`. Three tests: a passing task
  whose worker commits with a `Co-Authored-By: Claude` trailer and writes a robot footer and trailer into
  `.mastermind-result.md` reaches main as one squashed, trailer-free commit by the owner, with `main~1` the old main,
  no merge commits, the owner still on `dev`, and the clone and `refs/mastermind/` ref gone (reviewer on, no
  findings); two parallel tasks where `clash` strays into `README.md` and finishes only once `retitle` is on main,
  so its checks' rebase conflicts and a conflict fixer resolves it with a real `git rebase` (no attempt counted,
  rebase checks failed, passed, passed) before it lands on top of `retitle`; and a task whose acceptance keeps
  failing (`maxAttempts: 2`, judge says not flaky) gets one fixer, then is `blocked` with the "Blocked after 2
  attempts" event, shows as blocked in `mastermind tasks`, and main is untouched.
- **Ordering without sleeps.** The clash worker's last step is a bounded shell loop that polls the owner's repo
  until `retitle`'s squashed subject is on main, so the conflict is certain rather than timing-dependent.
- **No defects found.** The milestone 5 flows behaved as the integration tests describe; nothing in earlier work
  needed changing.

## m6-request-changes

- **Where it lives.** Core: `src/review/` (`notes.ts`: the `addComment`, `updateComment`, `deleteComment` and
  `dismissFinding` actions; `request-changes.ts`: the `requestChanges` action; `prompts.ts`: the fresh-mode prompt),
  a new package export `@mastermind/core/review`, and `SessionManager.startRound` in `sessions/manager.ts`. The
  message builder is `buildChangeRequest` in `contracts/request-changes.ts`, browser-safe, so the server and the
  web preview run the same function and the preview is the sent text byte for byte. `@mastermind/core/task-files` is
  a new export so tests can read changes without the whole read model. Web: `notes/` (pure helpers, the notes hook,
  the zone cards), `request/` (the Request changes screen parts), `decide/NotedFileView.tsx`,
  `review/view-zones.tsx`, `review/SinceToggle.tsx` and `screens/RequestChangesScreen.tsx`.
- **A `rounds` table (migration 2).** Section 12 has nowhere to keep what a round sent, which the Rounds history
  and a restarted round need, so each request-changes round stores `{task_id, round, mode, instruction, message,
  comment_ids, finding_ids, failing_check_id, start_commit, session_id, created_at}`, unique per task and round.
  Round 1 (the original run) has no row. The row, the session row, the task's new round and its move to `running`
  are one transaction; a spawn that fails removes the row and restores the round.
- **Changes since the previous round.** `round:N` now resolves to the `start_commit` of round N+1 when that round
  exists: the HEAD the owner reviewed when they asked for changes, which is after the checks rebased the branch.
  The old rule (the round's latest session `end_commit`) remains for a round with no later one. If main moves
  during a later round and the checks rebase onto it, the since-round diff includes main's changes too; accepted.
- **Rounds.** Only a task in `review` can start one (the action and, inside the start transaction, the manager both
  check, so a stay-current move to `checking` in between can't be overtaken). The round goes up by one, `attempts`
  resets to 0 so the round gets its full fixer budget, and the session is attempt 1. Like a steering resume, it is
  an explicit owner instruction, so it starts at once even while work is paused, but it is refused while sign-in is
  needed or a usage-limit back-off runs. The request is stored as a `steer` event (`Changes requested for round N`)
  on the new session, since the CLI's replay of a turn's own prompt isn't stored. When the session succeeds the
  usual settlement moves the task to `checking`, and the checks pipeline runs in full for the new round, ending in
  `review` or `rebasing` by the usual rules.
- **Modes.** `resume` continues the task's latest worker or fixer conversation (`--resume <claude_session_id>`, same
  clone, keeping that session's role and system prompt), and is refused with a 409 when no conversation got going.
  `fresh` starts a worker with a new session id and `--append-system-prompt-file prompts/refine.md`; its prompt is
  the task brief, a summary of the branch's changed files against the base commit, and the request. A round whose
  session later fails without a resumable conversation is restarted by the scheduler with that same fresh prompt
  (from the stored message), so the request isn't lost. That applies only when the task's clone is reused: after a
  discard the task starts again from main with the ordinary worker prompt, since the new clone holds none of the
  earlier rounds' work. Dismissed findings can't be sent.
- **Message.** The instruction, then the comments sorted by file and line (file, line or range, the excerpt in a
  fence longer than any backtick run in it, the text), the findings (`- severity · file:line: text`), and the
  failing check: the round's latest failed check, its last 60 lines of log (read with the same 1 MiB tail the check
  log route gives the browser). Comments are included by default, findings and the failing check only when ticked.
- **Comments and findings.** Comments carry the task's current round; they can be added while the task has a
  workspace and isn't done, and only the current round's can be edited or deleted (earlier ones were sent).
  Excerpts are cut to 40 lines in the browser. New bus events `comment.updated`, `comment.deleted` and
  `finding.updated` keep other tabs current; the terminal view ignores them. Routes: `GET/POST
  /api/tasks/:taskId/comments`, `PATCH/DELETE /api/tasks/:taskId/comments/:commentId` (`ActionRoute.method` gained
  `DELETE`), `POST /api/findings/:findingId/dismiss`, `POST /api/tasks/:taskId/request-changes`, plus `GET
  /api/tasks/:taskId/{findings,rounds,notes}`; `notes` returns comments, findings and rounds in one read.
- **Conductor.** `request_changes` is an ungated action tool (6.3); its action line is `✓ Requested changes on <id>
  (round N)`. A read tool `get_review_notes` gives the Conductor the comment and finding ids it needs, and the
  Conductor prompt gained a short paragraph on review rounds.
- **Monaco view zones.** Each zone's React content is portalled into a node Monaco places under the line, and a
  `ResizeObserver` keeps the zone's height equal to the content's. Three Monaco details shaped this: a zone of
  height 0 is `display: none` (so its content could never be measured), so zones start at 48 px; Monaco marks the
  view-zone layer `aria-hidden`, which would hide real controls from assistive technology, so the attribute is
  removed from that layer; and the view-lines layer paints above zones and takes their clicks, so our zones get
  `z-index: 1`. Keydown inside a zone stops at the zone, so typing a comment never reaches editor shortcuts.
  Selecting lines in the modified side (mouse or keyboard) enables "Comment on lines N–M" in the file header,
  which opens a draft zone under the selection.
- **Screens.** Test and decide gained "Request changes · N comments" (a link, enabled only in review), note counts
  in the file list, comment and finding zones (Delete, Dismiss), and a Changes toggle (All changes / Since round
  N−1, `?since=round:N`) from round 2 on; the session Review screen has the same toggle for a later-round session.
  The store's `changes` are keyed by task and `since`, and notes are a new store slice (`notes.loaded`). The Request
  changes screen is `/review/decide/:taskId/request-changes`; after sending it returns to Test and decide.
