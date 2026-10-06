# Claude CLI notes (M0 spikes)

Findings from running the ten spikes of `docs/PLAN.md` 16.2 against the real CLI. Every later task that spawns
`claude` or parses its output should read this first.

- **Version:** Claude Code 2.1.283 on macOS 15 (Darwin 24.6), signed in to a Max subscription.
- **Date:** 2026-10-05.
- **Model:** `--model haiku` (claude-haiku-4-5) unless a spike says otherwise.
- **Where:** every run used a throwaway directory or git repo under `/tmp/mm-spikes`.
- **Environment:** every run used the cleaned environment from [Spike 4](#spike-4-auth-failure-texts) and
  [Decisions](#decisions), through this wrapper:

```sh
exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_BASE_URL \
  -u CLAUDE_CODE_USE_BEDROCK -u CLAUDE_CODE_USE_VERTEX -u CLAUDE_CODE_USE_FOUNDRY \
  -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID -u CLAUDE_CODE_CHILD_SESSION \
  -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN \
  -u CLAUDE_CODE_EXECPATH -u CLAUDE_PID -u CLAUDE_EFFORT -u AI_AGENT \
  claude "$@"
```

Raw outputs are in `test/fixtures/claude-samples/`. They are redacted: the owner's email is `owner@example.com`,
the org id is `00000000-0000-4000-8000-000000000001` and the home folder is `/Users/owner`. Nothing else was
changed, so the files are byte-for-byte what the CLI printed. They are the contract fixtures for the event parser
(m1-events-parser).

| File | What it shows |
|---|---|
| `01-worker-run.jsonl` | Worker-like run: Read, Edit, Bash, `git commit`, result (bypassPermissions) |
| `01-partial-messages.jsonl` | `--include-partial-messages`: `stream_event` lines (text, tool input and thinking deltas) |
| `02-json-schema.jsonl` | `--json-schema`: `StructuredOutput` tool call and `result.structured_output` |
| `03-rate-limit-events.jsonl` | Distinct `rate_limit_event` lines collected from all runs |
| `04-auth-invalid-token.jsonl` | Invalid `CLAUDE_CODE_OAUTH_TOKEN`: `api_retry` 401, synthetic error message, error result |
| `04-auth-not-logged-in.jsonl` | Empty config dir: "Not logged in · Please run /login" |
| `04-auth-status-*.json` | `claude auth status --json`: signed in (Max), logged out, invalid OAuth token |
| `05-stdin-inject.jsonl` | Stream-json input: message injected mid-turn, second turn after `result` (`--replay-user-messages`) |
| `05-stdin-interrupt.jsonl` | `control_request` interrupt mid-turn, then a new turn on the same process |
| `06-mcp-http.jsonl` | HTTP MCP server with bearer header, `--tools "Read,Grep,Glob"`, MCP tool call |
| `07-accept-edits-denied.jsonl` | acceptEdits + allowlist with stream-json input: `system/permission_denied`, no hang |
| `07-dont-ask-denied.jsonl` | dontAsk + allowlist: unlisted Bash denied, listed tools run |
| `07-auto-unavailable-for-model.jsonl` | `--permission-mode auto` with haiku silently runs as `default` |
| `08-attribution-default.jsonl` | Commit made without attribution settings: the Bash command carries `Co-Authored-By` |
| `10-sandbox-bypass.jsonl` | Sandbox and deny rules under bypassPermissions: `<sandbox_violations>`, deny-rule refusal |
| `10-path-guard-hook.jsonl` | PreToolUse hook used as a path guard: outside writes refused |
| `10-sandbox-apply-failed.jsonl` | Sandbox that cannot apply: every Bash call fails with exit 71 |

## Spike 1: stream-json event shapes and --verbose

**Command** (cwd = temp git repo with `hello.py`, stdin `/dev/null`):

```sh
claude -p --model haiku --output-format stream-json --verbose --permission-mode bypassPermissions \
  --settings '{"attribution":{"commit":"","pr":"","sessionUrl":false}}' \
  "Do these steps in order using tools: 1) Read hello.py. 2) Edit hello.py ... 3) Run the Bash command: python3 hello.py && echo ran. 4) git add -A and git commit ..."
```

Also run without `--verbose`, and with `--include-partial-messages` (`01-partial-messages.jsonl`).

**Observed:**

- **`--verbose` is required.** Without it, the CLI prints
  `Error: When using --print, --output-format=stream-json requires --verbose` and exits 1.
- **One JSON object per line.** Stdout carried nothing else, and stderr was empty in every successful run. These
  are the line types seen, by `type` / `subtype`:
  - `system/init`: first line of every turn. Fields: `session_id`, `cwd`, `model`, `permissionMode`, `tools[]`,
    `mcp_servers[] {name,status,source}`, `claude_code_version`, `apiKeySource` (`"none"` on a subscription),
    `slash_commands`, `skills`, `plugins`, `agents`, `capabilities`, `memory_paths`, `messaging_socket_path`, `uuid`.
    **A persistent stream-json process emits a fresh `init` at the start of every turn** (spike 5).
  - `system/thinking_tokens`: `{estimated_tokens, estimated_tokens_delta}`. This is noise.
  - `system/status`: `{status: "requesting"}`. Only seen with partial messages. This is noise.
  - `assistant`: `{message: {id, model, role, content[], stop_reason, usage}, parent_tool_use_id, session_id, uuid,
    request_id?, error?}`.
    - **Each content block arrives as its own `assistant` line**, and the lines share `message.id`. For example,
      a `thinking` line is followed by a `tool_use` line with the same id. Thinking text is always `""`; only the
      signature is present.
    - `tool_use` blocks are `{id, name, input, caller}`. Seen `input` shapes:
      - Read: `{file_path}`
      - Edit: `{file_path, old_string, new_string, replace_all}`
      - Write: `{file_path, content}`
      - Bash: `{command, description}`
      - MCP tools are named `mcp__<server>__<tool>`
  - `user` with `content[].type == "tool_result"`: `{tool_use_id, content (string or blocks), is_error?}`, plus a
    structured `tool_use_result`:
    - Read: `{type:"text", file:{filePath, content, numLines, ...}}`
    - Edit: `{filePath, oldString, newString, ...}`
    - Bash: `{stdout, stderr, interrupted, ...}`

    Bash failures have `is_error: true`, with content starting `Exit code N`.
  - `system/task_started` and `system/task_notification` wrap a foreground Bash call (`task_type: "local_bash"`,
    `tool_use_id`, `description`, `status: "completed"`). They duplicate the tool_use and tool_result.
  - `system/vcs_state_changed`: `{kind: "commit" | "push" | "merge" | "rebase", branch, cwd}`. It is emitted when a
    Bash command changed git state. Seen right after the `git commit`.
  - `rate_limit_event`: `{rate_limit_info: {status, resetsAt, rateLimitType, utilization?, overageStatus, isUsingOverage, unifiedWindows: {five_hour, seven_day}}}`
    (spike 3).
  - `result`: one per turn.
    - Fields: `subtype` (`success` | `error_during_execution` | ...), `is_error`, `result` (final text),
      `session_id`, `num_turns`, `duration_ms`, `stop_reason`, `terminal_reason` (`completed` | `api_error` |
      `aborted_streaming`), `api_error_status`, `usage` (summed over the turn's API calls), `modelUsage[model]`
      (`contextWindow`, `maxOutputTokens`, ...), `total_cost_usd`, `permission_denials[]`, `result_index`,
      `structured_output?`.
    - **`subtype: "success"` does not mean success:** auth failures report `subtype: "success"` with
      `is_error: true`. Always read `is_error`.
- **Partial messages.** `--include-partial-messages` adds `stream_event` lines whose `event` is the raw Messages API
  streaming event:
  - `message_start` and `content_block_start` (text, thinking or tool_use)
  - `content_block_delta`, whose `delta.type` is `text_delta`, `input_json_delta`, `thinking_delta` or
    `signature_delta`
  - `content_block_stop`, `message_delta` and `message_stop`

  The complete `assistant` lines are still emitted as well.
- **Variadic flags swallow a positional prompt.** `--tools`, `--allowedTools`, `--mcp-config` and `--add-dir` take
  lists, so `claude -p --tools "" "say ok"` read the prompt as a tool name and failed with "Input must be
  provided". Putting `--` before the prompt fixes this.
- **Config dir.** `CLAUDE_CONFIG_DIR=""` (set but empty) made the CLI create `backups/ cache/ plugins/ projects/
  sessions/ skills/` in the cwd.
- **Claude.ai connectors.** The owner's claude.ai connectors (Gmail, Drive and others) are loaded into every `-p`
  session unless `--strict-mcp-config` is passed. With `--strict-mcp-config`, `mcp_servers` was `[]`.

**Decision:**

- Always pass `--output-format stream-json --verbose`.
- Send prompts on stdin (stream-json for worker, fixer and Conductor; stdin text for one-shot judge and reviewer
  calls) and never as a positional argument.
- Always pass `--strict-mcp-config`, so no owner connectors leak into sessions.
- Group `assistant` lines by `message.id` only when the UI needs a whole message. Events are derived per line.
- Take the Conductor's context size from the **last `assistant` line's** `usage`
  (`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`), not from `result.usage`, which is
  summed over the turn. The limit is `result.modelUsage[model].contextWindow`.
- `total_cost_usd` is an API-price estimate. On a subscription it is not billed, so store it but never call it cost.
- The environment cleaner drops `CLAUDE_CONFIG_DIR` when it is set to an empty string.

## Spike 2: --json-schema output location

**Command** (cwd = empty temp dir):

```sh
claude -p --model haiku --output-format stream-json --verbose --max-turns 1 --tools= --strict-mcp-config \
  --json-schema '{"type":"object","properties":{"flaky":{"type":"boolean"},"reason":{"type":"string"}},"required":["flaky","reason"],"additionalProperties":false}' \
  -- "A test failed once with 'ETIMEDOUT connecting to registry' and passed on retry. Is it flaky?"
```

**Observed:**

- The model answers by calling a built-in **`StructuredOutput`** tool, whose `input` is the object. This works even
  with `--tools=` (no tools).
- The `result` line carries the parsed object in **`result.structured_output`**, and the same object as a JSON
  string in `result.result`.
- `num_turns` was 2 even with `--max-turns 1`, and the run still succeeded. The StructuredOutput round trip does
  not trip the limit.

**Decision:**

- Judge and reviewer calls read `result.structured_output` and validate it with the same zod schema that produced
  the `--json-schema` argument.
- If `structured_output` is missing or invalid, or `is_error` is true, the call fails as a typed error. Never fall
  back to scraping `result.result`.
- Pass `--tools ""` to the judge as two argv entries, with the prompt on stdin.

## Spike 3: usage-limit exit code and text

The usage limit can't be reached on demand, so this spike records what can be observed and what the CLI ships.

**Observed live:** every run printed `rate_limit_event` lines (`03-rate-limit-events.jsonl`), for example:

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1791277800,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.11,"resetsAt":1791277800},"seven_day":{"utilization":0.44,"resetsAt":1791615600}}},"uuid":"…","session_id":"…"}
```

`resetsAt` values are Unix seconds. `utilization` is a fraction from 0 to 1, and can go above 1.

**From the CLI's own schemas** (`strings` on the 2.1.283 binary):

- **`rate_limit_info.status`** is `"allowed" | "allowed_warning" | "rejected"`.
- **`rate_limit_info.rateLimitType`** is `"five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" |
  "seven_day_overage_included" | "overage"`.
- **`assistant.error` is a closed enum:** `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`,
  `verification_required`, `billing_error`, `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`,
  `server_error`, `unknown`, `max_output_tokens`, `cloud_credential_error`.
  - An HTTP 429 becomes a synthetic assistant message (`model: "<synthetic>"`, `is_api_error_message: true`) with
    `error: "rate_limit"`.
  - The CLI's own status mapping labels `billing_error` as "usage limit reached — check plan".
- **`system/api_retry`** is `{attempt, max_retries, retry_delay_ms, error_status, error}`. It is emitted before
  each retry; `error` uses the same enum.
- **User-facing texts in the binary:** "You've hit your limit" (the CLI composes this line itself from a 429),
  "usage limit reached", "you have reached your weekly usage limit", "You're out of extra usage", "You've hit your
  monthly spend limit", "Usage limit approaching". The 429 path also appends "resets <time>" text.

**Exit code:** not observed. Every API-error run seen (spike 4) exits **1**, with an empty stderr and the reason
in the final `result` line, so a usage-limit stop is expected to look the same.

**Decision:**

- A run counts as **usage-limited** if any of these hold:
  - a `rate_limit_event` has `rate_limit_info.status == "rejected"`. Its `resetsAt` becomes the resume time.
  - an `assistant` line has `error` in `{rate_limit, billing_error}`.
  - the `result` line has `api_error_status == 429`.
  - the `result` line has `is_error: true` and its text matches
    `/usage limit|hit your (?:\w+ )?limit|weekly (?:usage )?limit|out of extra usage|spend limit/i`.
- `status: "allowed_warning"` only updates the visible usage meter. It never pauses anything.
- **Fallback:** any non-zero exit, missing `result` or `is_error` result that is classified as neither auth nor
  usage limit triggers the global back-off of PLAN 7.3 (principle 2.6), without counting an attempt. A per-task cap
  stops a deterministic error from looping; see [Decisions](#usage-limit-and-auth-detection-rules).
- `system/api_retry` lines are shown as "retrying" and never classified on their own. The CLI retries 429s and
  5xxs itself; only the final `result` and exit decide the outcome.

## Spike 4: auth failure texts

**Commands** (temp `CLAUDE_CONFIG_DIR`, so the owner's sign-in is never read or touched):

```sh
CLAUDE_CONFIG_DIR=/tmp/mm-spikes/cfg-sandbox claude auth status --json
CLAUDE_CONFIG_DIR=/tmp/mm-spikes/cfg-sandbox CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-invalid-spike-token claude auth status --json
CLAUDE_CONFIG_DIR=/tmp/mm-spikes/cfg-sandbox CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-invalid-spike-token \
  claude -p --model haiku --output-format stream-json --verbose --strict-mcp-config --tools= -- "say ok"
CLAUDE_CONFIG_DIR=/tmp/mm-spikes/cfg-sandbox claude -p --model haiku --output-format stream-json --verbose --strict-mcp-config --tools= -- "say ok"
```

**Observed:**

- **`auth status --json` when logged out** exits **1**, but still prints JSON on stdout:
  `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty",...}`.
- **`auth status --json` with an invalid OAuth token** exits 0 and reports
  `{"loggedIn":true,"authMethod":"oauth_token","apiProvider":"firstParty",...}`. There is **no `email` and no
  `subscriptionType`**. The status command does not validate the token.
- **When signed in normally** it reports `authMethod: "claude.ai"`, `email`, `orgId`, `orgName` and
  `subscriptionType: "max"` (`04-auth-status-signed-in.json`).
- **A run with an invalid token** (`04-auth-invalid-token.jsonl`) exits **1** with an empty stderr. In order, it
  prints:
  1. `system/init`
  2. two `system/api_retry` lines with `error_status: 401` and `error: "authentication_failed"`
  3. a synthetic `assistant` line with `error: "authentication_failed"`, `is_api_error_message: true` and the text
     `Failed to authenticate. API Error: 401 OAuth access token is invalid.`
  4. a `result` line with `subtype: "success"`, `is_error: true`, `api_error_status: 401` and
     `terminal_reason: "api_error"`

  It took 1.9 s.
- **A run when not logged in** (`04-auth-not-logged-in.jsonl`) exits **1** after 43 ms. The assistant line has
  `error: "authentication_failed"` and the text `Not logged in · Please run /login`. The `result` has
  `is_error: true`, `api_error_status: null` and the same text. Plain text output prints the same line and exits 1.
- **Other auth texts the CLI ships** (from the binary):
  - "OAuth token has expired", "OAuth token has been revoked", "OAuth access token is invalid"
  - "Invalid bearer token", "Login expired · Please run /login", "OAuth token revoked · Please run /login"
  - "Credential is invalid"
  - "Could not refresh your login because another Claude Code process is refreshing it" (transient: retry, not
    sign-in)

**Decision:**

- A run is an **auth failure** if any of these hold:
  - an `assistant` line has `error` in `{authentication_failed, oauth_org_not_allowed}`.
  - the `result` has `api_error_status` 401.
  - the `result` has `is_error: true` and its text matches
    `/not logged in|please run \/login|failed to authenticate|oauth (?:access )?token (?:has expired|has been revoked|is invalid)|invalid bearer token|login expired/i`.
- On an auth failure, mastermind runs `claude auth status --json` (the auth gate) before setting `authRequired`. The
  failed session goes back to `pending` without counting an attempt (PLAN 4.3).
- The status runner parses stdout whatever the exit code. Exit 1 together with `loggedIn: false` is the normal
  "not signed in" answer, not a crash.
- **Auth classifier:** `authMethod: "oauth_token"` (from `CLAUDE_CODE_OAUTH_TOKEN`) carries no `subscriptionType`,
  so it cannot be shown to be Pro or Max. Following PLAN 4.1, it is accepted only if `subscriptionType` is present
  and is `pro` or `max`. Otherwise it is refused with an explanation that names `CLAUDE_CODE_OAUTH_TOKEN`.
  - A *valid* setup-token was not tested, because running `claude setup-token` is forbidden. Revisit this if a
    valid token turns out to report its plan.

## Spike 5: stream-json input, mid-run injection and open stdin

**Command:** a Node driver that spawns the process (detached) and writes JSON lines to its stdin. The driver also
logs every line it receives.

```sh
claude -p --model haiku --input-format stream-json --output-format stream-json --verbose \
  --strict-mcp-config --permission-mode bypassPermissions --tools Bash [--replay-user-messages]
```

Each message is written as `{"type":"user","message":{"role":"user","content":"<text>"}}`. The driver did this:

1. Sent the task: "Run `sleep 4; echo slept` ... reply with one sentence".
2. At the first `tool_use`, sent "Additional instruction: ... end your final reply with the word BANANA."
3. After the first `result`, kept stdin open for 15 s, then sent a second turn ("reply with just CHERRY").
4. After the second `result`, waited 5 s and closed stdin.

A second driver sent `{"type":"control_request","request_id":"req-1","request":{"subtype":"interrupt"}}` 1 s
after a `tool_use`.

**Observed (`05-stdin-inject.jsonl`, `05-stdin-interrupt.jsonl`):**

- **Injection mid-turn works.** The injected message was delivered at the next tool boundary, after the running
  Bash call's `tool_result`. It was folded into the **same turn**: one `result` (`num_turns: 2`), and the reply
  ended with "BANANA".
- **`--replay-user-messages`** echoes every stdin user message back as a `user` line with `isReplay: true` and
  string `content`, at the moment it is delivered to the model. This serves as the acknowledgement that a steering
  message arrived.
- **The process stays alive after `result` while stdin is open.** It sat idle for 15 s with no output.
- **A new message starts a new turn.** It emits a new `system/init`, then `assistant` lines, then a `result` with
  `result_index: 1`. The `session_id` is unchanged.
- **Closing stdin exits the process** about 0.4 s later with exit code 0.
- **Interrupt.** The CLI answered with
  `{"type":"control_response","response":{"subtype":"success","request_id":"req-1","response":{"still_queued":[]}}}`,
  then emitted:
  - a `user` line with text `[Request interrupted by user]`
  - a `result` with `subtype: "error_during_execution"`, `is_error: true` and `terminal_reason: "aborted_streaming"`

  The process stayed alive, and the next stdin message ran normally.
- **Long sleeps are blocked.** Claude Code's Bash tool refused `sleep 30; echo late` itself
  (`<tool_use_error>Blocked: sleep 30 followed by ...`). Long `sleep` commands are blocked by the CLI, not by
  mastermind.
- **Session ids.**
  - `--session-id <uuid>` followed by a later `--resume <uuid>` kept the same `session_id`, and the context was
    remembered.
  - Reusing `--session-id` with an id that already exists fails with `Error: Session ID <uuid> is already in use.`
    and exit 1.

**Decision:**

- Worker, fixer and Conductor sessions use stream-json input with `--replay-user-messages`.
- **Steering** (`message_session`) is a stdin write. The replayed `isReplay` line becomes the `steer` event and
  confirms delivery.
- A worker's session ends at its first `result`, and mastermind then closes stdin (PLAN 8.4). Steering is accepted
  only before that `result`. After it, `message_session` falls back to `--resume <id>`.
- Interrupting the Conductor's turn sends `control_request` `interrupt`. It does not use a signal.

## Spike 6: HTTP MCP with an Authorization header and --tools

**Setup:** a throwaway Node HTTP server speaking MCP's streamable-HTTP JSON-RPC (plain JSON responses). It requires
`Authorization: Bearer spike-token` (401 otherwise) and exposes one tool, `get_summary`.

```sh
cat mcp.json
{"mcpServers":{"mastermind":{"type":"http","url":"http://127.0.0.1:4799/mcp","headers":{"Authorization":"Bearer spike-token"}}}}

claude -p --model haiku --output-format stream-json --verbose --mcp-config mcp.json --strict-mcp-config \
  --tools "Read,Grep,Glob" --allowedTools "mcp__mastermind__* Read Grep Glob" \
  -- "Call the mastermind get_summary tool, then Read README.md, and tell me the secret word and the README text."
```

**Observed (`06-mcp-http.jsonl`):**

- **The header was sent on every request.** The server saw, in order:
  1. `server/discover` (answered "method not found", which is fine)
  2. `initialize`
  3. `notifications/initialized`
  4. a `GET /mcp` (answered 405, which is fine)
  5. `tools/list`
  6. `tools/call`
- **`init.tools`** was `["Glob","Grep","Read","mcp__mastermind__get_summary"]`, and `mcp_servers` was
  `[{"name":"mastermind","status":"connected","source":"dynamic"}]`. **`--tools` limits only built-in tools; MCP
  tools stay available.**
- **The MCP call ran without a prompt**, through the `mcp__mastermind__*` allow rule. Its tool_result content is
  the server's block array.
- **With a wrong token:** the server returned 401, `init.mcp_servers` showed `status: "failed"`, and the session
  carried on without the tools. It did not fail.

**Decision:**

- The Conductor spawn in PLAN 6.2 works as written.
- `ChatRunner` checks the first `system/init` of each process: if `mastermind` is not `connected`, it kills the
  process and reports a typed error. It does not let the Conductor run blind.
- The real MCP server must keep accepting POSTs with plain JSON responses and answer `GET` with 405. Unknown
  methods (`server/discover`) return JSON-RPC errors.

## Spike 7: headless permissions

**Commands** (cwd = temp git repo with `Makefile` `test: ; @echo tests passed`, stdin `/dev/null` unless noted):

```sh
claude -p --model haiku --output-format stream-json --verbose --strict-mcp-config --permission-mode bypassPermissions -- "1) Bash: make test 2) Bash: uname -s 3) Write notes.txt"
claude -p ... --permission-mode acceptEdits --allowedTools "Bash(make test)" -- "<same, then touch, Edit, node -e write>"
claude -p ... --permission-mode dontAsk --allowedTools "Bash(make test)" "Edit" -- "<same>"
claude -p ... --permission-mode auto --allowedTools "Bash(make test)" -- "<same>"            # haiku, then sonnet
claude -p ... --input-format stream-json --permission-mode acceptEdits --allowedTools "Bash(make test)" [--permission-prompts none]
```

**Observed:**

- **bypassPermissions:** `make test`, `uname -s` and Write all ran, headless, on the Max subscription. No
  prompts, and `permission_denials` was `[]`.
- **acceptEdits + `--allowedTools "Bash(make test)"`:**
  - `make test` ran, and so did Edit and Write in the cwd.
  - It also allowed read-only commands (`uname -s`) and simple file-system commands (`touch`) that weren't on the
    list.
  - An unlisted command (`node -e "...writeFileSync..."`) was **denied immediately** with
    `This command requires approval`. Nothing waited.
- **dontAsk + allowlist:** unlisted Bash was denied with "Permission to use Bash has been denied because Claude Code
  is running in don't ask mode". Listed Edit and `make test` ran.
- **Stream-json input changes nothing.** With `--input-format stream-json` (`07-accept-edits-denied.jsonl`), a
  denial is **not** sent to the host as a `can_use_tool` request. It is denied at once. A `system/permission_denied`
  line `{tool_name, tool_use_id, decision_reason_type, decision_reason, message}` precedes the error tool_result.
  With `--permission-prompts none` the reason becomes "no approval surface in this session; permission request
  denied automatically".
- **auto:**
  - With **haiku**, the CLI accepted the flag but `init.permissionMode` was **`"default"`**. Edits and `touch`
    were then refused ("needs approval"). The binary contains "auto mode unavailable for this model" and "... for
    your plan".
  - With **sonnet**, `init.permissionMode` was `"auto"`, and `touch`, Edit and `make test` all ran with no denials.
- **User settings leak in.** The owner's `~/.claude/settings.json` (its `additionalDirectories`, allow rules and
  hooks) is loaded into every session. The denial message listed the owner's additional working directories.

**Decision:**

- `workerPermissions: bypass` (the default) maps to `--permission-mode bypassPermissions`. This is confirmed to
  work headless.
- `auto` maps to `--permission-mode auto`.
- `allowlist` maps to `--permission-mode acceptEdits --allowedTools <workerAllowedTools>`, as in PLAN 8.3. Edits
  in the worktree are allowed, and unlisted commands are denied without waiting.
- Every worker and fixer also passes `--permission-prompts none`, so that no permission request can ever wait on
  the host.
- After spawn, mastermind compares `init.permissionMode` with the requested mode. If they differ (for example
  `auto` on a model without auto mode), the session fails with a typed error that names the mode and model. It does
  not run with weaker or stronger permissions than configured.
- `system/permission_denied` lines become `error` events, so a stuck allowlist is visible.
- The owner's user settings stay loaded; mastermind does not pass `--setting-sources project,local`. They carry
  the owner's plugins, hooks and model preferences. Their extra directories and allow rules can't widen a worker's
  reach: the path guard confines Edit and Write, and the sandbox confines Bash (spike 10). Mastermind's own
  `--settings` object overrides `attribution` either way (spike 8). `doctor` lists the owner's
  `additionalDirectories` so they are visible.

## Spike 8: attribution through --settings

**Commands** (temp repo whose identity is `Owner <owner@example.com>`). `--setting-sources project,local` skips
the owner's user settings, which already turn attribution off:

```sh
claude -p --model haiku ... --setting-sources project,local --permission-mode bypassPermissions \
  -- "Append a line 'b' to a.txt, then commit it with git using the commit message 'Add b'. Follow your normal commit conventions."
claude -p --model haiku ... --setting-sources project,local --permission-mode bypassPermissions \
  --settings '{"attribution":{"commit":"","pr":"","sessionUrl":false}}' -- "<same prompt>"
```

**Observed:**

- **Without the settings** the commit message was `Add b` followed by
  `Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>`. The model wrote it in a heredoc
  (`08-attribution-default.jsonl`).
- **With `--settings` attribution off** the message was exactly `Add b`, with no trailer. Spike 1's commit, made
  with the same `--settings` and the owner's settings, was also clean.
- The author and committer were the repo's configured identity in both cases.

**Decision:** pass the attribution object through `--settings` on every spawn (PLAN 11, layer 2). It works under
`-p`. The rebase-queue guard stays as the backstop. Its regex `^Co-Authored-By:.*(Claude|anthropic)` matches the
observed trailer, which names the model (`Claude Haiku 4.5`), so the match must not depend on a fixed model name.

## Spike 9: process groups and kill(-pgid)

**Demo:** run as its own group leader like a foreground job (`perl -e 'setpgrp(0,0); exec @ARGV' node spike9.mjs`).
It sends `SIGINT` to its own group, which is what the terminal does on Ctrl+C, and then `SIGKILL` to the detached
child's group:

```js
import { spawn, execFileSync } from "node:child_process";

const show = (label) => {
  const pgids = new Set([process.pid, detached.pid]);
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((row) => pgids.has(Number(row.trim().split(/\s+/)[2])) && !row.includes(" ps -axo"));
  console.log(`-- ${label}\n${rows.join("\n")}`);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

const detached = spawn("sh", ["-c", "sleep 301 & sleep 302; wait"], { detached: true, stdio: "ignore" });
const attached = spawn("sh", ["-c", "sleep 303; wait"], { stdio: "ignore" });
detached.on("exit", (code, signal) => console.log(`detached child exited code=${code} signal=${signal}`));
attached.on("exit", (code, signal) => console.log(`attached child exited code=${code} signal=${signal}`));
process.on("SIGINT", () => console.log(`parent ${process.pid} received SIGINT and keeps running`));

await settle();
console.log(`parent pid=${process.pid}; detached child pid=${detached.pid}; attached child pid=${attached.pid}`);
show("before SIGINT (pid ppid pgid command)");
process.kill(-process.pid, "SIGINT");
await settle();
show("after SIGINT to the parent's group");
process.kill(-detached.pid, "SIGKILL");
await settle();
show("after SIGKILL to the detached child's group");
```

Output of the original run, whose script also echoed each `kill` call. Re-running the script above during review
printed the same process tables with different pids:

```
parent pid=81427 (group leader); detached child pid=81436; attached child pid=81445
-- before SIGINT  (pid ppid pgid command)
81427 81425 81427 node spike9.mjs
81436 81427 81436 sh -c sleep 301 & sleep 302; wait
81445 81427 81427 sh -c sleep 303; wait
81446 81436 81436 sleep 301
81447 81436 81436 sleep 302
81448 81445 81427 sleep 303
kill(-81427, SIGINT)
parent 81427 received SIGINT and keeps running
attached child exited code=null signal=SIGINT
-- after SIGINT to the parent's group
81427 81425 81427 node spike9.mjs
81436 81427 81436 sh -c sleep 301 & sleep 302; wait
81446 81436 81436 sleep 301
81447 81436 81436 sleep 302
kill(-81436, SIGKILL)
detached child exited code=null signal=SIGKILL
-- after SIGKILL to the detached child's group
81427 81425 81427 node spike9.mjs
```

The detached child and its `sleep`s were not reached by the SIGINT, while the attached child died. `kill(-pgid)`
took down the detached child and both `sleep`s.

**With the real CLI** (paths trimmed; detached `claude -p ... --permission-mode bypassPermissions --tools Bash`, asked to run a
`make test` whose recipe runs `python3 -c "import time; time.sleep(45)"`):

```
81809 81807 81809 claude -p --model haiku ...
81879 81809 81879 /bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-….sh ... make test
81881 81879 81879 make test
81882 81881 81879 python3 -c import time; time.sleep(45)
kill(-81809, SIGKILL)
-- 2 s after SIGKILL
81882 81881 81879 python3 -c import time; time.sleep(45)      ← orphan survives
```

- **Claude Code runs every Bash tool command in a new process group.** The pgid is the tool shell's pid.
  `kill(-claudePgid, SIGKILL)` kills claude but **leaves `make` and its children running**.
- **SIGTERM to claude's group:** claude exits with code 143 and kills its tool groups itself. Nothing was left
  after 2 s.
- **Killing the whole tree works.** Taking one `ps -axo pid=,ppid=,pgid=` snapshot, collecting every descendant of
  the claude pid, and sending `SIGKILL` to each distinct pgid left nothing behind.
- **Env markers can't be read on macOS.** `ps -E` and `ps eww` don't show other processes' environments, so an
  inherited environment marker can't find orphans there.

**Decision:**

- Every child keeps `detached: true`. The terminal's SIGINT never reaches sessions, and mastermind's own handler
  decides.
- `stopSession` sends SIGTERM to the session's group first, which lets claude clean up its tool groups. After
  10 s it SIGKILLs the whole tree, as below.
- **Ctrl+C twice:**
  1. Take one `ps -axo pid=,ppid=,pgid=` snapshot.
  2. For every live session, collect the pgids of all its descendants.
  3. SIGKILL each of those groups, plus each session's own group.
  4. Repeat once to catch processes spawned during the kill.

  A `ps` snapshot takes about 10 ms, so this fits easily within the 500 ms budget.
- While a session runs, mastermind periodically records the pgids of its descendants in SQLite, for example on
  each `tool_use` event and every few seconds.
- The startup reaper (PLAN 3.5) kills recorded pgids that are still alive, after checking that the group's
  processes are not mastermind's own. This covers a hard crash of mastermind itself, where no tree snapshot is
  possible.
- The fake-claude `hang` mode should spawn a grandchild in its own group, so the M1 Ctrl+C test exercises this.

## Spike 10: sandbox without prompts

**Command** (stream-json input, cwd = temp repo `repo10`, plus sibling dirs `outside/` and `outside2/`):

```sh
claude -p --model haiku --input-format stream-json --output-format stream-json --verbose --strict-mcp-config \
  --permission-mode bypassPermissions --settings '{
    "sandbox": {"enabled": true, "autoAllowBashIfSandboxed": true, "allowUnsandboxedCommands": false,
                "failIfUnavailable": true,
                "network": {"allowedDomains": ["registry.npmjs.org"], "strictAllowlist": true},
                "filesystem": {"allowWrite": []}},
    "permissions": {"deny": ["Edit(//private/tmp/mm-spikes/outside/**)", "Write(//private/tmp/mm-spikes/outside/**)",
                             "Edit(//tmp/mm-spikes/outside/**)", "Write(//tmp/mm-spikes/outside/**)"]}}'
```

The prompt asked for six steps (`10-sandbox-bypass.jsonl`). Every run had a 120 s watchdog to catch any wait.

| Step | Result |
|---|---|
| Bash `echo x > …/outside/bash.txt` | **Blocked** by seatbelt: `(eval):1: operation not permitted`, exit 1 |
| Bash `curl https://example.com` | **Denied, no waiting**: `CONNECT tunnel failed, response 403` plus `<sandbox_violations>deny network-outbound example.com:443 (host is not on the allow list)</sandbox_violations>` |
| Bash `curl https://registry.npmjs.org/` | Allowed: `200` |
| Write `…/outside/write-denied.txt` (deny rule) | **Blocked**: `File is in a directory that is denied by your permission settings.` |
| Write `…/outside2/write-nodeny.txt` (no deny rule) | **Succeeded**: the file was written outside the worktree |
| Bash `echo ok > inside.txt` | Allowed |

The whole run took 15 s, and nothing waited for input. The sandbox also left an empty `.claude/` dir in the cwd;
git ignores empty dirs.

**`failIfUnavailable`:**

- On macOS, `/usr/bin/sandbox-exec` always exists, so the sandbox can't be made "unavailable" here.
- Running claude inside an outer `sandbox-exec` makes seatbelt fail to apply. The session still started, but
  every Bash call failed closed with `Exit code 71` / `sandbox-exec: sandbox_apply: Operation not permitted`
  (`10-sandbox-apply-failed.jsonl`), and the session carried on to a `result`.
- The binary's message for a truly missing backend is
  `sandbox unavailable detail: … Set sandbox.failIfUnavailable=false to allow unsandboxed execution.`

**Linux is untested.** This machine has no `bwrap` or `socat`, and running the CLI in a container would mean
copying the owner's credentials, which is not allowed. Whether `failIfUnavailable` stops a Linux session without
bubblewrap at startup, or only at the first Bash call, is unknown.

**Path guard check** (decision 9 asks for this). The same settings plus a `PreToolUse` hook on
`Edit|Write|MultiEdit|NotebookEdit` that runs a small Node script (`10-path-guard-hook.jsonl`):

- The script reads the hook's JSON from stdin and resolves `tool_input.file_path` (relative to `cwd`, through
  symlinks, for example `/tmp` → `/private/tmp`).
- If the path is outside the worktree, it prints
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"mastermind: <path> is outside this task's worktree"}}`.

Under `bypassPermissions` the hook blocked `/private/tmp/…/outside2/guarded.txt` and
`/tmp/…/repo10/../outside2/guarded2.txt` (the CLI hands the hook a normalised path). It allowed the relative
`inside-write.txt`. Each refusal shows up in `permission_denials`.

**Decision:**

- The sandbox settings of decision 9 work headless on macOS:
  - writes outside the worktree are blocked
  - unlisted hosts are denied without a prompt
  - `<sandbox_violations>` in a tool_result names what was blocked, which feeds the "Allow it for this project?"
    offer
- Deny rules only cover the paths they list, and the sandbox does **not** confine Edit or Write. So mastermind
  **does need its own path guard**; see [Decisions](#decisions).
- A tool_result containing `sandbox_apply: Operation not permitted`, or the "sandbox unavailable" text, ends the
  session as a sandbox failure. The task is blocked with a clear message, and `doctor` reports it.

## Decisions

### ChatRunner: one persistent process

Spike 5 showed that a stream-json process:

- survives after `result` with stdin open
- runs each new stdin message as a new turn with the same `session_id`
- accepts messages injected mid-turn
- supports `control_request` interrupt
- exits cleanly when stdin closes

So **ChatRunner uses one persistent Conductor process** (`--input-format stream-json --replay-user-messages`). It
works like this:

- The process is spawned with `--session-id <uuid>` the first time and `--resume <uuid>` afterwards.
- It is killed after 10 minutes idle and resumed by id on the next message.
- A turn ends at its `result`. The per-turn `system/init` is used only to re-check that the `mastermind` MCP server
  is `connected`.
- "Stop" in the chat sends `control_request` `{subtype:"interrupt"}`.

### Steering method

`message_session` writes `{"type":"user","message":{"role":"user","content":<text>}}` to the live session's stdin.

- The message is delivered at the next tool boundary of the current turn.
- `--replay-user-messages` echoes it as a `user` line with `isReplay: true`, which becomes the `steer` event and
  confirms delivery.
- After the session's `result`, stdin is closed, so steering falls back to `--resume <id>` with the message
  (PLAN 8.5).

### Usage-limit and auth detection rules

Apply these checks in order to a finished run (its lines, its final `result` and its exit code):

1. **Auth failure** if any of these hold. Response: run `claude auth status --json`, then set `authRequired`. The
   attempt is not counted.
   - an `assistant` line has `error` in `{authentication_failed, oauth_org_not_allowed}`
   - `result.api_error_status == 401`
   - `result.is_error` is true and the text matches
     `/not logged in|please run \/login|failed to authenticate|oauth (?:access )?token (?:has expired|has been revoked|is invalid)|invalid bearer token|login expired/i`
2. **Usage limit** if any of these hold. Response: global back-off until `resetsAt` from the latest
   `rate_limit_event`, or the default back-off if there is none. The attempt is not counted.
   - any `rate_limit_event` has `rate_limit_info.status == "rejected"`
   - an `assistant` line has `error` in `{rate_limit, billing_error}`
   - `result.api_error_status == 429`
   - `result.is_error` is true and the text matches
     `/usage limit|hit your (?:\w+ )?limit|weekly (?:usage )?limit|out of extra usage|spend limit/i`
3. **Unrecognised failure**: a non-zero exit, a process that ended without a `result` line, or `result.is_error`,
   matching neither rule above. Response: global back-off, the same as a usage limit (PLAN 7.3). The attempt is not
   counted, because it may be an unseen limit text.
   - So that a deterministic CLI error (a bad flag, `Session ID … is already in use`) can't retry forever, each
     task also keeps a separate count of consecutive unrecognised failures. The count resets on any run that gets
     past rule 3. After 3 in a row the task becomes `blocked`, and its message shows the last `result` text and
     stderr.
4. **A successful run** has exit 0, a `result` with `is_error: false`, and no rule above matched. The task's own
   checks then decide whether the work is good.

Runs that mastermind ended itself are not classified by these rules. They are recorded with the reason mastermind
had: `stopSession`, Ctrl+C, a stuck-check kill, or a Conductor interrupt. Such runs end with SIGTERM's exit code
143, a SIGKILL signal, or an interrupt's `error_during_execution` result.

Every observed API error exited with code 1 and an empty stderr. Classify from stdout and keep stderr only for the
log.

### Mapping stream-json lines to PLAN 8.4 events

Lines marked "not stored" are kept in the raw session log (`.mastermind/logs/`) but get no `events` row.

| Line | Event type | Summary |
|---|---|---|
| first `system/init` of a process | `start` | `<model> · <permissionMode> · <n> tools` |
| later `system/init` (new turn) | not stored | Re-checks MCP status only |
| `assistant` `tool_use` Read / Grep / Glob / LS / NotebookRead / WebFetch / WebSearch / `mcp__*` | `read` | `Read <relative path>`, `Grep "<pattern>"`, `<tool name>` |
| `assistant` `tool_use` Edit / MultiEdit / Write / NotebookEdit | `edit` | `Edit <relative path>` |
| `assistant` `tool_use` Bash | `run` | `input.description`, else the first line of `input.command` |
| `system/vcs_state_changed` with `kind: "commit"` | `commit` | `Committed on <branch>`; mastermind then reads git for the hash and subject |
| `system/vcs_state_changed`, other kinds | `note` | `git <kind> on <branch>` |
| `assistant` `text` block | `note` | First line of the text |
| `user` with `isReplay: true`, the first one of a turn | not stored | The turn's own prompt (the task, or the owner's chat message) |
| `user` with `isReplay: true`, later in the same turn | `steer` | The message text |
| `result` with `is_error: false` | `result` | `Done in <num_turns> turns` |
| `result` with `is_error: true` | `error` | `result.result`, or the `terminal_reason` |
| `assistant` with `error` set (synthetic) | `error` | The text, plus the error code |
| `system/permission_denied` | `error` | `Denied <tool_name>: <message>` |
| `user` `tool_result` with `is_error: true` | `error` | `<tool> failed: <first line>` (exit code or sandbox violation) |
| `user` `tool_result`, success | not stored | Pairs with its `tool_use` by `tool_use_id` |
| `system/api_retry` | `note` | `API retry <attempt>/<max_retries> (<error>)` |
| `rate_limit_event` | not stored | Feeds the usage meter and the limit rule |
| `assistant` `thinking` block, `system/thinking_tokens`, `system/status`, `system/task_started`, `system/task_notification` | not stored | Noise |
| `stream_event` (partial messages) | not stored | `text_delta` goes to `chat.delta` for the Conductor |
| `control_response`, unknown types and subtypes | not stored | Parsed leniently and never fatal |

The parser validates each line against a zod discriminated union on `type`, with a passthrough for unknown fields.
A line that fails validation is logged and skipped. It never ends the session.

A turn ends at its `result` line, whether `is_error` is true or false. So "the session ended" (PLAN 8.4) is detected
from the line type, not from the derived event type, which is `error` for a failed result.

### Nested-session variables to remove

Claude Code sets these in its children. Mastermind removes all of them from every `claude` child and from the
`auth status` check, so a mastermind started from a terminal inside Claude Code behaves like one started from a
plain terminal:

- `CLAUDE_CODE_MESSAGING_TOKEN` and `CLAUDE_CODE_MESSAGING_SOCKET`. These are the parent session's private
  channel.
  - **They change behaviour.** With the token inherited, the child ran as a sub-session of the parent: it did not
    load the claude.ai connectors (`mcp_servers: []`). It must never be able to talk to the parent.
- `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED`,
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_PID`, `AI_AGENT`.
  - These describe the parent session's identity and whether it is attended. None of them changed a `-p` run on
    its own in 2.1.283, and nesting is not refused, but they belong to another session.
- `CLAUDE_EFFORT`. This is the parent's effort level. Mastermind sets effort explicitly when it needs to.

Also removed are the auth and provider variables in PLAN 4.4:

- `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`
- `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY`
- any other provider-selecting `ANTHROPIC_*` variable
- `CLAUDE_CONFIG_DIR` when it is empty

`CLAUDE_CODE_OAUTH_TOKEN` is kept. `GIT_EDITOR=true`, which Claude Code also sets, is harmless and left as it is.
The cleaner uses this exact list rather than a `CLAUDE_*` prefix, so the owner's own tuning variables still pass
through.

### Path guard (decision 9): yes, mastermind needs one

Spike 10 showed that under `bypassPermissions` with the sandbox on, Edit and Write **can write outside the
worktree** unless a deny rule names that path. Deny rules can't express "everything except the worktree", because
deny beats allow. So mastermind adds its own path guard:

- **What it is:** a `PreToolUse` command hook on `Edit|Write|MultiEdit|NotebookEdit`, injected through the same
  `--settings` object on every worker and fixer spawn.
- **What it runs:** a small script shipped with mastermind (`node <mastermind>/path-guard.js <worktree>`).
- **What it does:**
  - resolves `tool_input.file_path` or `notebook_path` against `cwd`, following symlinks
  - denies anything outside the worktree, using `permissionDecision: "deny"` and a reason that names the path
  - allows everything else silently
- **Pure logic:** the path-safety check is a pure function, unit-tested with `..`, symlinks, `/tmp` →
  `/private/tmp` and relative paths.

It works headless and under bypass, and each refusal appears as a permission denial in the stream. The deny rules
in PLAN 8.3 stay as a second layer for the owner's repo and `~/.claude`.

The CLI's `--restricted` flag also confines file tools to the working directories, but according to `claude --help`
it refuses `bypassPermissions`, removes Bash unless `--tools` names it, and needs a person to approve writes to git
files. That rules it out for workers and fixers (decision 3). It was not run live.
