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
