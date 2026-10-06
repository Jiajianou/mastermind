# Mastermind: build plan

## 1. What mastermind is

Mastermind runs many headless Claude Code sessions in parallel against one software project.

The owner works through a chat. They describe what they want, and mastermind turns it into a graph of small tasks. Each task runs in its own Claude Code session and git worktree, in parallel where the graph allows. Mastermind tests each result, lets the owner review it and request changes, and rebases finished work onto the main branch.

```
$ cd ~/code/myos
$ mastermind .
```

That one command does everything:
1. Checks the owner's Claude sign-in and prompts them to sign in if needed.
2. Starts the orchestrator.
3. Prints a link to a local web app for this repository.
4. Keeps the terminal as a live status view.

Mastermind keeps the terminal in the foreground. **Pressing Ctrl+C twice kills every running session immediately and exits.** The terminal always shows this.

## 2. Principles and constraints

1. **Claude Pro and Max subscriptions only.** Every LLM call goes through the `claude` CLI, signed in with a claude.ai subscription. There is no API key support, Anthropic API or Agent SDK, and no Bedrock, Vertex or Foundry. Mastermind refuses to run on any other kind of auth (section 4).
2. **Mastermind never stores credentials.** Sign-in, token storage and refresh all belong to Claude Code. Mastermind only checks the sign-in state and starts Claude Code's own login flow.
3. **The terminal owns the lifetime.** Mastermind runs while its terminal runs. Closing the browser tab changes nothing. Ctrl+C twice, closing the terminal, or a crash kills every child process.
4. **Sessions are disposable.** All state lives in SQLite and git. A session does one job and exits, and nothing depends on its context surviving.
5. **The orchestrator is plain code.** Scheduling, state, retries, checks and rebasing are deterministic. An LLM is used only for judgement: implementing, fixing, reviewing, planning, the chat, and small classifications.
6. **The usage limit is shared.** All sessions draw on one subscription limit. The default is 1 worker on Pro and 2 on Max. When the limit is hit, mastermind backs off globally.
7. **One action layer.** Every state change is one validated function. The web UI, the chat and the CLI all call the same functions.
8. **No Claude attribution in git**, in this repo or any repo mastermind manages (section 11).
9. **Single user, local machine.** Mastermind binds to `127.0.0.1`, and a per-run token protects the API.

## 3. Running mastermind

### 3.1 Startup sequence

1. **Find the repo.** Resolve the path with `git rev-parse --show-toplevel`. If it is not a git repo, exit with an error.
2. **Single instance.** Take `.mastermind/lock` (pid and port). If a live mastermind already holds the lock, print `mastermind is already running for this repo (pid 41213) → <link>` and exit 1.
3. **Check Claude Code.** `claude` must be on PATH at or above the minimum version. If not, tell the owner how to install or update it.
4. **Auth gate** (section 4). Sign in if needed, and refuse anything that is not a subscription.
4a. **Keep the owner off main** (decision 6). If the owner's checkout is on `mainBranch`, mastermind asks before going further:
   ```
   You're on main. Mastermind rebases finished work onto main, so please work on another branch.
   ▸ Switch to a new branch "dev" (keeps your uncommitted changes)
     Switch to an existing branch…
     Quit
   ```
   It uses `git switch`, which carries uncommitted changes along. If the owner checks out main later while mastermind runs, rebasing onto main pauses, and the terminal and chat ask them to switch again.
5. **First-run setup:**
   - Create `.mastermind/` and add `/.mastermind/` and `/.mastermind-result.md` to `.git/info/exclude`. This changes nothing tracked in the repo.
   - Auto-detect `build`, `test` and `setup` commands from `package.json` scripts, `Makefile`, `Cargo.toml`, `go.mod` or `pyproject.toml`.
   - Write `.mastermind/config.yaml`.
   - The Conductor's first chat message asks the owner to confirm the detected commands.
6. **Recover** from the previous run (3.5).
7. **Start the server.** Use port 4700, or the next free port. Generate a new random token and write it to `.mastermind/token` with mode 600.
8. **Render the terminal view** (3.2) and print the link `http://127.0.0.1:4700/#t=<token>`.
   - The token is in the URL fragment, so it never reaches a server log.
   - The web app moves the token into `sessionStorage` and removes it from the address bar.

### 3.2 Terminal view

Mastermind renders the terminal view with Ink (React for terminals) in raw mode. When stdout is not a TTY, it prints plain log lines instead.

```
 mastermind · myos · main @ 18ab0ad                      jiajian.ou@gmail.com · Max
 Web app → http://127.0.0.1:4700/#t=8f3c2a91…   (o open · c copy)

 RUNNING  2 of 2 workers                       QUEUE  4 remaining · 1 review · 0 blocked
 ▸ ext2-driver     worker  opus   12m   Edit kernel/fs/ext2/inode.rs
 ▸ vfs-cache       fixer#2 opus    3m   Run  make test   (build failed)

 14:02:11  ext2-driver   Commit  "ext2: read superblock"
 14:02:40  rebase        sched-prio rebased onto main
 14:03:05  vfs-cache     Start   fixer attempt 2 of 3

 p pause · o open · c copy link · Ctrl+C twice to quit (stops all sessions)
```

- The footer hint is always visible.
- The `o`, `c` and `p` keys open the browser, copy the link, and pause or resume the scheduler.
- Five event lines scroll. Full detail is in the web app.

### 3.3 Ctrl+C twice

| Press | What happens |
|---|---|
| First | The footer turns orange: `Press Ctrl+C again to quit. This kills 2 sessions and 1 check immediately. Worktrees are kept.` The prompt stays armed for 2 seconds, then the footer returns to normal. Nothing is stopped. |
| Second, within 2 s | The kill path runs. Nothing is graceful; it must take under 500 ms. |

The kill path does these steps in order:

1. `process.kill(-pgid, "SIGKILL")` for every tracked child process group: Claude sessions, checks, rebase commands and the Conductor. Then `pty.kill("SIGKILL")` for each "Try it" terminal.
2. One synchronous transaction marks all running sessions `killed`, along with their checks and rebases.
3. Close the HTTP and WebSocket server, restore the terminal, and release the lock.
4. Print the summary below and exit with code 130.

```
Stopped mastermind. Killed 2 sessions, 1 check.
Worktrees kept. Unfinished tasks resume on the next `mastermind .`
```

Rules that make this work:

- **Each child gets its own process group.** Every child is spawned with `detached: true`, so the first Ctrl+C, which the terminal sends to its foreground process group, never reaches the children. Mastermind reads Ctrl+C itself as the `\x03` key in raw mode. It also traps `SIGINT` when not in raw mode, using the same two-press logic.
- **Other ways the process ends.** `SIGHUP` (terminal closed), `SIGTERM` and an uncaught exception all run the kill path at once.
- **Orphans after a hard kill.** `SIGKILL` on mastermind itself cannot be trapped, so the next startup cleans up (3.5).

### 3.4 What the owner is told

- **Startup banner:** `Ctrl+C twice stops mastermind and every session it started.`
- **Terminal footer:** the hint is permanent.
- **Web app:** the top bar shows `Running · Max`, and its tooltip carries the Ctrl+C note. When the server goes away, the page shows `mastermind stopped (terminal closed or Ctrl+C). Run mastermind . to continue.`

### 3.5 Recovery on the next start

1. **Reap leftover processes.** For each session still marked `running`:
   - If its pid is alive and `ps -o command=` contains that session's `--session-id`, kill its process group.
   - Mark the session `killed`.
2. **Save uncommitted work.** For each worktree with uncommitted changes, commit them as `WIP: interrupted`. Use no trailers.
3. **Requeue interrupted tasks.** Return them to `pending` with `resume_session` set. When the scheduler next starts the task, it runs `--resume <claude_session_id>` with "You were interrupted. Check the worktree state and continue." Interrupted runs do not count as attempts.

## 4. Authentication (Pro and Max only)

Claude Code already handles login, secure token storage (the macOS Keychain, or `~/.claude/.credentials.json` on Linux) and token refresh. Mastermind builds on that. So after one sign-in the owner is **not asked again until Claude Code's sign-in actually expires or is revoked**.

### 4.1 The check

Run `claude auth status --json` with the same cleaned environment used for every child process (4.4). This is a verified sample of the output:

```json
{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty",
  "email": "jiajian.ou@gmail.com", "subscriptionType": "max", ... }
```

The sign-in is accepted only if all of these hold:
- `loggedIn` is true
- `authMethod` is `"claude.ai"`
- `apiProvider` is `"firstParty"`
- `subscriptionType` is `pro` or `max`

### 4.2 The four outcomes

| State | Terminal behaviour |
|---|---|
| Accepted | `✓ Signed in as jiajian.ou@gmail.com (Max)`, then continue. |
| Not signed in | `Mastermind needs a Claude Pro or Max account. Press Enter to sign in in your browser · Esc to quit`. Enter hands the terminal to `claude auth login --claudeai` with inherited stdio, which runs Claude Code's own flow: it opens the browser and offers a URL-and-code fallback. When it exits, mastermind checks again. After 3 failures it exits. |
| Signed in, wrong kind (Console or API billing, another provider, or a plan other than Pro or Max) | `This account uses <API billing / free plan / …>. Mastermind supports Claude Pro and Max subscriptions only.` The owner can sign in with a different account: mastermind warns that this signs Claude Code out everywhere on this machine, then runs `claude auth logout` and `claude auth login --claudeai`. The other choice is Quit. |
| Expired mid-run | See 4.3. |

### 4.3 Expiry while running

**Detection.** A child exits with an auth failure. M0 records the exact `result` and stderr text. In addition, a check runs every 15 minutes and before any session starts if the last check is more than 5 minutes old.

**Response:**
1. Set `authRequired`.
2. Pause the scheduler.
3. Return sessions that failed on auth to `pending`, without counting an attempt.
4. **Terminal:** `Your Claude sign-in expired. Press Enter to sign in again.` This uses the same login hand-off as 4.2.
5. **Web:** a banner reads `Sign-in needed: finish it in the terminal running mastermind`.
6. After a good check, clear the flag and resume.

Mastermind never shows a login form of its own and never handles a token.

### 4.4 Environment cleaning (every `claude` child and the status check)

**Remove:**
- `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_BASE_URL`
- `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY`, plus any `ANTHROPIC_*` variable that selects a provider

**Keep:**
- `CLAUDE_CODE_OAUTH_TOKEN`, a subscription token from `claude setup-token`. It is accepted only if the check still reports `claude.ai` with Pro or Max.

**Settings-file auth.** An `apiKeyHelper` in the owner's Claude settings would show up in the check as a non-`claude.ai` method, so it is rejected with an explanation.

**Never pass** `--bare`. It skips OAuth and requires an API key.

## 5. Architecture

Mastermind is one Node process: the CLI, the terminal view and the service share a process. It runs in the foreground and supervises every child.

```
terminal (foreground)                                    children (each in its own process group)
┌───────────────────────────── mastermind ─────────────────────────────┐
│ Ink terminal view   ◄─ store ─►   actions.ts (only writer)           │   claude -p  worker / fixer   cwd = worktree
│ Fastify /api/* + WS /api/stream   ◄── browser (React app, same port) │   claude -p  reviewer / judge
│ MCP /mcp                          ◄── Conductor (claude -p)          │   claude -p  Conductor (chat)
│ scheduler · sessions · git · checks · rebase queue · auth guard     │   sh -c build/test/setup
│ node:sqlite  .mastermind/db.sqlite      logs .mastermind/logs/       │   node-pty  "Try it"
└──────────────────────────────────────────────────────────────────────┘
```

**One action layer.** Every mutation is a function in `actions.ts` with a zod schema, for example:
- `createTasks`, `updateTask`, `hold`, `release`, `retry`
- `stopSession`, `messageSession`, `requestChanges`
- `approve`, `discard`, `pause`, `resume`, `setConfig`

Each action is exposed as an HTTP route, an MCP tool for the Conductor, and a CLI subcommand. Each one emits a WebSocket event and updates the terminal view.

## 6. The Conductor: the chat home screen

### 6.1 Role

The web app opens on a chat. The Conductor is a Claude session that runs mastermind for the owner. It can:
- answer status questions
- turn a vision into a task graph
- create, edit and reprioritise tasks
- start, stop, hold and retry work
- steer a running worker
- request changes
- propose rebases onto main (for protected paths) and discards

It acts only through mastermind's MCP tools. It may read the repo with Read, Grep and Glob, but it has **no Bash, Edit or Write**.

### 6.2 How a turn runs

```
claude -p --session-id <uuid> (first turn) | --resume <uuid> (later)
  --model <models.conductor>
  --output-format stream-json --verbose --include-partial-messages
  --mcp-config .mastermind/run/conductor-mcp.json --strict-mcp-config
  --tools "Read,Grep,Glob" --allowedTools "mcp__mastermind__* Read Grep Glob"
  --append-system-prompt-file prompts/conductor.md
  --settings '{"attribution":{"commit":"","pr":"","sessionUrl":false}}'
cwd = repo root, cleaned env
```

`conductor-mcp.json` points at `http://127.0.0.1:<port>/mcp` with the bearer token in a header.

**Runner choice.** `ChatRunner` hides two ways of running the Conductor. M0 picks one:
- **One process per turn.** Simple, but each turn has a cold start.
- **One persistent process** using `--input-format stream-json`. Each user message is written to stdin. The process is killed after 10 minutes idle and resumed by id. This also supports interrupting a turn and adding a message mid-turn. It is preferred if it works.

**Streaming.** Partial text goes to the UI as `chat.delta`. Each tool call becomes one muted "done" line under the reply (6.5).

**State digest.** Each turn starts with a digest of about 300 tokens: counts by status, running sessions, "needs you", and pause and auth state.

**History.** `chat_messages` is the source of truth for what the UI shows. When the Conductor's context grows large (tokens are read from `result` events), a judge call summarises it and a new session starts from the summary plus the digest. The chat looks continuous to the owner.

### 6.3 MCP tools

| Tool | Effect | Needs a click |
|---|---|---|
| `get_summary`, `list_tasks`, `get_task`, `list_sessions`, `get_session_events`, `get_changes`, `get_check_log` | read | no |
| `create_tasks` (batch, validated as a DAG), `update_task`, `set_priority` | edit the graph | no |
| `hold`, `release`, `retry`, `pause_all`, `resume_all`, `stop_session` | control | no |
| `message_session(sessionId, text)` | steer a live session (8.5) | no |
| `request_changes(...)` | start a new round (10) | no |
| `propose_plan(tasks[])` | shows the plan as a numbered list | Start (or "go ahead") |
| `approve_rebase`, `discard_task`, `set_config` | irreversible or broad | **yes** |

**Gated actions.** A gated tool stores a `proposals` row and returns `awaiting_confirmation`. The chat shows a small decision box with two buttons, such as **Rebase** and **Not now** (6.5). The click calls the same action over HTTP, and the outcome becomes a system message the Conductor sees on its next turn.

### 6.4 Event lines in the chat (no LLM cost)

Mastermind posts a short centred line, such as `11:02 · sched-prio is ready for review`, only for events that **need the owner or change main**:
- a task is ready for review
- a task is blocked
- a task was rebased onto main
- sign-in is needed
- the usage limit was hit, with the resume time

Routine events, such as a fixer retrying or a check running, stay out of the chat and appear on Overview and Sessions. `conductor.wakeOnEvents` optionally gives the Conductor a turn after these events. It is off by default.

### 6.5 Chat UI: keep it as simple as a normal chat

The owner sees a chat with "mastermind", not a control panel. The internal names "Conductor", MCP and tool names never appear in the UI.

- **Layout.** One centred column, at most 760px wide. There are no side panels.
- **Status pill.** At the top: `2 working · 1 needs you · 7 of 14 done`. It is the only always-on status and links to Overview.
- **Two message styles:**
  - **Yours:** a right-aligned bubble.
  - **Mastermind's:** plain text on the left, with no label or avatar.
- **What it did.** One muted line under the reply, for example `✓ Added 5 tasks and started 2` or `✓ Sent to ext2-driver`. There are no expandable tool cards. The full record is in Sessions.
- **Plans.** A plain numbered list: task id, then a short note such as "after the first two". Starting it is just "go ahead" in the chat, or one Start button. There is no table or graph in the chat; the graph lives in Tasks.
- **Decisions.** One small box with a question and at most two buttons, for example "Rebase sched-prio onto main?" with **Rebase** and **Not now**, plus a "See changes" link. This is the confirmation step from 6.3.
- **Input.** One rounded box: "Ask or tell mastermind anything" with **Send**. Send becomes **Stop** while mastermind is replying. A small model menu (for example `Opus ▾`) sits beside Send; it defaults to Opus and the choice is remembered for the project.
  - Enter sends; Shift+Enter adds a newline.
  - `@task` and `/pause` work but aren't advertised on screen.
- **First run.** The heading "What should we build in myos?", one setup question confirming the detected build and test commands (**Use these** / **Change**), and three starter buttons: "Plan work from a goal", "Import tasks.yaml" and "What can you do?".
- **Banners.** Sign-in needed and mastermind stopped each get one line across the top.

## 7. Tasks

### 7.1 Fields

| Field | Meaning |
|---|---|
| `id` | A slug, such as `ext2-driver` |
| `title`, `goal` | What to build and why |
| `acceptance` | A shell command that must exit 0 |
| `touches` | Path prefixes the task may edit |
| `deps` | Task ids that must be `done` first |
| `priority` | An integer; higher runs first |

Tasks can be imported from and exported to `tasks.yaml`, with the fields `id`, `title`, `goal`, `acceptance`, `deps` and `touches`. An import is rejected if it has a cycle or an unknown dependency. While mastermind runs, the database is the source of truth.

### 7.2 State machine

```
pending ──► running ──► checking ──► review ──► rebasing ──► done
              ▲            │            │           │
              │   fail     │  request   │   fail    │
              └────────────┴────────────┴───────────┘
                 (attempts < maxAttempts, else ► blocked)

review ──► pending     discard: delete branch and worktree
held                   flag on any task; the scheduler skips it
killed session ──► pending (resume), no attempt counted
```

| Status | Meaning |
|---|---|
| `running` | A worker or fixer session is active. |
| `checking` | The checks pipeline (9.2) is running. |
| `review` | Waiting for the owner. Only used for tasks that touch a path in `requireReviewFor`; every other task that passes its checks is rebased onto main automatically (decision 2). |
| `blocked` | Failed `maxAttempts` times and needs the owner. |

### 7.3 Scheduler

The scheduler runs every few seconds and after every state change.

```
ready(task) =
  status == pending and not held and not authRequired and not paused
  and every dep is done
  and no path in task.touches is a prefix of, or prefixed by, a path in
      the touches of any task that is running, checking, review or rebasing
start ready tasks by priority until active worker + fixer sessions == maxWorkers
(reviewer, judge and Conductor calls don't count toward maxWorkers; at most one reviewer runs at a time)
```

**Rate limits.** On a usage-limit exit, pause new starts and back off exponentially: 5 minutes, doubling, capped at 60. The terminal view and the chat both show the resume time.

## 8. Sessions

### 8.1 Roles

| Role | What it does | Tools | Default model |
|---|---|---|---|
| worker | Implements a task in its worktree | full Claude Code | opus |
| fixer | Fixes failed checks or rebase conflicts in the same worktree | full Claude Code | opus |
| reviewer | Reviews a finished branch in a fresh context and returns `[{file,line,text,severity}]`, where severity is `minor` or `serious` | Read, Grep, Glob | sonnet |
| judge | Small decisions: is a failure flaky, summarise, roll over context | none, `--max-turns 1 --json-schema` | haiku |
| conductor | The chat (6) | MCP plus read-only | opus (switchable in the chat) |

### 8.2 Task workspace (a local clone, decision 20)

In this plan, a task's "worktree" means its own **local clone**, not a `git worktree`. Workers can then only touch their own clone, never the owner's `.git`.

- **Create.** Run `git clone --local --single-branch --branch <mainBranch> <repo> <worktreeDir>/<id>`. Objects are hard-linked, so it's fast and cheap on disk. Then run `git -C <clone> switch -c task/<id>`.
- **Cut the link back.** Remove the clone's `origin` remote, so a worker has no path back to the owner's repo. Mastermind, which isn't sandboxed, moves commits between the two itself:
  - **Fetching main into the clone:** `git -C <clone> fetch <repo> +refs/heads/<main>:refs/remotes/upstream/<main>`.
  - **Bringing the task into the repo:** `git -C <repo> fetch <clone> task/<id>:refs/mastermind/<id>`.
- **Setup.** Add `/.mastermind-result.md` to the clone's `.git/info/exclude`, and store `base_commit`.
- **Dependencies.** Run `commands.setup` (for example `pnpm install`) once and record it as a `setup` check row.

### 8.3 Spawn

```
claude -p --session-id <uuid> --model <model>
  --input-format stream-json --output-format stream-json --verbose
  --permission-mode <bypassPermissions | auto | acceptEdits> [--allowedTools <workerAllowedTools>]   # from workerPermissions
  --append-system-prompt-file prompts/worker.md
  --settings '<attribution off (11) + sandbox block (decision 9) + deny rules for paths outside the worktree>'
cwd = worktree, cleaned env (4.4), detached: true (own process group)
```

The task prompt is sent as the first stdin message. The worker prompt includes:
- the task goal, the acceptance command, and the paths it may touch
- "read CLAUDE.md first"
- "commit when the acceptance command passes"
- "do not edit outside the listed paths without saying why in the commit message"
- "write a short summary to `.mastermind-result.md`"
- "never add Co-Authored-By or other AI-attribution trailers"

### 8.4 Events

Mastermind reads stdout line by line. Each line is stored in `events` with:
- a derived `type`: start, read, edit, run, note, commit, steer, result or error
- a one-line `summary`
- the raw line as `payload`

Each event is broadcast as `session.event` and shown in the terminal view. The session counts as ended when its `result` event arrives; mastermind then closes stdin. At that point:
1. Record `end_commit`.
2. Commit any uncommitted changes as `WIP: uncommitted at session end`.
3. Move the task to `checking`.

### 8.5 Steering

`message_session` writes a user message into the live session's stdin. If the session has already ended, or stdin injection fails the M0 spike, it falls back to `--resume <id>` with the message.

### 8.6 Stop

`stopSession` sends SIGTERM to the process group, then SIGKILL after 10 seconds. Ctrl+C twice skips straight to SIGKILL (3.3).

## 9. Git, checks and rebasing

### 9.1 Git service

The diff always compares the base commit with the **working directory**, so edits show up while a session is still working.

| Need | Command |
|---|---|
| Task clones | listed from the `tasks` table (`worktree` column holds the clone path) |
| Changed files, including uncommitted | `git -C <wt> diff --name-status --numstat <base_commit>` plus `git -C <wt> status --porcelain` |
| Base file | `git show <base_commit>:<path>` |
| Current file | read from disk in the worktree |
| Changes since the previous round | diff against that round's session `end_commit` |
| File tree | `git -C <wt> ls-files` plus untracked files |

**Path safety.** Every `file` and `tree` request resolves the path, follows symlinks, and rejects anything outside that task's worktree.

### 9.2 Checks pipeline

The pipeline runs when a session ends, in this order. Each check is a `checks` row with a log file.

1. **Build:** `commands.build` in the worktree.
2. **Acceptance:** the task's `acceptance` command.
3. **Rebase onto main:** fetch current main into the clone as `upstream/<main>`, then rebase the task branch onto it.
   - If there is a conflict, mastermind **resolves it automatically**: it aborts the rebase and starts a fixer session with the conflict output, which redoes the rebase and resolves the conflicts in the task's worktree.
   - This does not count as a failed attempt unless the fixer gives up.
4. **Full suite:** `commands.test` on the rebased branch, so it tests exactly what would end up on main.
5. **Reviewer session:** writes its results to `findings`, each tagged `minor` or `serious` (a likely bug, a security issue, or the task not actually done). Minor findings are informational. **Serious findings send the task to a fixer** with those findings (decision 21), then checks and review run again.

If check 1, 2 or 4 fails, or the reviewer reports a serious finding, and attempts remain, a fixer starts with the failing log or the findings, without waiting for the owner. Each fixer round counts as an attempt; after `maxAttempts` the task is `blocked`. If everything passes, the task goes to `rebasing`, or to `review` if it touches a path in `requireReviewFor` (decision 2).

**Staying current.** Whenever main moves, mastermind rebases every finished branch that hasn't reached main yet onto the new main, resolving conflicts the same way, and re-runs checks 4 and 5.

### 9.3 Rebase queue (never merge)

Mastermind **never creates merge commits**. Work reaches main by rebasing onto it and fast-forwarding, so main's history stays linear. Only one task is rebased onto main at a time.

1. Rebase the task branch onto current main. Conflicts are resolved automatically as in 9.2, step 3.
1a. **Squash** the branch into one commit (decision 13) with `git reset --soft <main>` and then `git commit`. The message is written by mastermind:
   - a subject from the task title, for example `ext2: read-only ext2 driver`
   - a body with the worker's summary from `.mastermind-result.md` and the task id
   - no trailers

   WIP, fixer and steering commits disappear into it.
2. Run the **attribution guard** (11).
3. Run `commands.build` and `commands.test` on the rebased branch.
4. Fetch the squashed commit from the clone into the owner's repo (`refs/mastermind/<id>`). Then fast-forward main with `git update-ref refs/heads/<main> <commit> <old-main>`, which only succeeds if main hasn't moved. This is safe because main is never checked out anywhere (decision 6). There is never a merge commit. Delete the clone and the `refs/mastermind/<id>` ref.
5. Mark the task `done` and wake the scheduler.

## 10. Review and refinement

- **Line comments.** The owner adds line comments in the diff. Each is stored in `comments` with the current round.
- **Request changes.** One message is built from these parts:
  - the overall instruction
  - the selected comments (file, line, excerpt, text)
  - the selected reviewer findings
  - optionally, the failing test output

  The UI shows the exact text before sending. This is also available to the Conductor as `request_changes`.
- **Who does the work:**
  - *Continue the same session:* `--resume <claude_session_id>` in the same worktree. It keeps what the session learned and suits small follow-ups.
  - *Start a fresh session:* a new worker reads the task, a diff summary and the notes. It suits a first attempt that went the wrong way.
- **Rounds.** `round` goes up by one and the task returns to `running`. When the round ends, the checks re-run and the task returns to `review`.
- **Try it yourself.** The owner types a command. It runs under `node-pty` in the task's rebased worktree and streams to the page. There is one terminal per task, with a Stop button.

## 11. No Claude attribution

No commit or PR produced by mastermind or its sessions contains `Co-Authored-By: Claude`, "Generated with Claude Code", `Claude-Session:` or any similar line. Four layers enforce this:

1. **Owner's global Claude settings.** `~/.claude/settings.json` has `"attribution": {"commit": "", "pr": "", "sessionUrl": false}`. This is already set on the owner's machine. Mastermind's `doctor` command reports it.
2. **Per spawn.** Every `claude` child gets the same object through `--settings`, so the rule holds on any machine.
3. **Prompts.** The worker, fixer and Conductor prompts forbid attribution trailers and footers.
4. **Rebase-queue guard.** This is the deterministic backstop.
   - Because every task is squashed (decision 13), mastermind writes the final message itself. The guard strips any line matching `^Co-Authored-By:.*(Claude|anthropic)`, `Generated with \[Claude Code\]` or `^Claude-Session:`, which could arrive through `.mastermind-result.md`.
   - It then scans `git log <main>..<branch> --format=%B` once more. If anything still matches, it stops the rebase onto main. Main never receives such a commit.

Commits keep the owner's git identity. Mastermind's own WIP commits carry no trailers.

## 12. Data model (`.mastermind/db.sqlite`, `node:sqlite`)

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL,
  acceptance TEXT NOT NULL, touches TEXT NOT NULL,          -- JSON array
  status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, round INTEGER NOT NULL DEFAULT 1,
  held INTEGER NOT NULL DEFAULT 0, resume_session TEXT,
  branch TEXT, worktree TEXT, base_commit TEXT,
  created_at TEXT, updated_at TEXT
);
CREATE TABLE task_deps (task_id TEXT, depends_on TEXT, PRIMARY KEY (task_id, depends_on));
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY, task_id TEXT,
  role TEXT,              -- worker | fixer | reviewer | judge | conductor
  round INTEGER, attempt INTEGER, claude_session_id TEXT, pid INTEGER, pgid INTEGER,
  model TEXT,
  status TEXT,            -- running | succeeded | failed | stopped | killed | rate_limited | auth_failed
  end_commit TEXT, input_tokens INTEGER, output_tokens INTEGER,
  started_at TEXT, ended_at TEXT
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY, session_id INTEGER, ts TEXT,
  type TEXT,              -- start | read | edit | run | note | commit | steer | result | error
  summary TEXT, payload TEXT
);
CREATE TABLE checks (
  id INTEGER PRIMARY KEY, task_id TEXT, round INTEGER,
  kind TEXT,              -- setup | build | acceptance | rebase | suite | reviewer
  status TEXT,            -- running | passed | failed | killed
  summary TEXT, log_path TEXT, duration_ms INTEGER
);
CREATE TABLE findings (id INTEGER PRIMARY KEY, task_id TEXT, round INTEGER,
  file TEXT, line INTEGER, text TEXT, severity TEXT,  -- minor | serious
  dismissed INTEGER DEFAULT 0);
CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id TEXT, round INTEGER,
  file TEXT, line_start INTEGER, line_end INTEGER, excerpt TEXT, text TEXT);
CREATE TABLE rebases (id INTEGER PRIMARY KEY, task_id TEXT, status TEXT, log_path TEXT, ts TEXT);
CREATE TABLE chat_messages (id INTEGER PRIMARY KEY, ts TEXT,
  kind TEXT,              -- user | conductor | action | proposal | plan | system
  content TEXT, meta TEXT, conductor_session TEXT, turn_id TEXT);
CREATE TABLE proposals (id INTEGER PRIMARY KEY, ts TEXT, action TEXT, args TEXT,
  status TEXT,            -- pending | confirmed | rejected | expired
  decided_at TEXT, result TEXT);
CREATE TABLE conductor_sessions (id TEXT PRIMARY KEY, started_at TEXT, ended_at TEXT,
  summary TEXT, tokens INTEGER);
```

## 13. Configuration (`.mastermind/config.yaml`)

An optional committed `mastermind.yaml` at the repo root supplies **defaults**. `.mastermind/config.yaml`, which Settings writes, overrides it, so a change made in Settings always takes effect.

```yaml
mainBranch: main
worktreeDir: ~/.mastermind/worktrees/myos-3f9a2c   # central folder: <repo name>-<short hash of the repo path>
maxWorkers: auto            # auto = 1 on Pro, 2 on Max
maxAttempts: 3
models: { worker: opus, reviewer: sonnet, judge: haiku, conductor: opus }   # the chat model can be switched in the UI
commands: { setup: "", build: make build, test: make test }
autoRebase: true            # passing tasks are rebased onto main automatically (+ fast-forward), never a merge commit
requireReviewFor: []        # paths that always wait for the owner, e.g. [kernel/vfs/]
workerPermissions: bypass   # bypass (default, inside the worktree) | auto | allowlist; changeable in Settings
workerAllowedTools: ["Bash(git *)", "Bash(make *)"]
reviewer: { enabled: true }                       # Settings toggle; the reviewer runs on every task
notifications: { desktop: true }                  # Settings toggle
stuckCheck: { after: 60m, every: 20m }            # no hard limit; a judge decides if a session is stuck
sandbox: { enabled: true, allowedDomains: [], allowWrite: [] }   # on by default, never prompts; presets added per toolchain
conductor: { confirm: [approve_rebase, discard_task, set_config], wakeOnEvents: [] }
port: 4700
```

## 14. Interfaces

### 14.1 HTTP API

Every route requires `Authorization: Bearer <token>` and uses JSON in and out.

| Route | Purpose |
|---|---|
| `GET /api/summary` | Counts by status, active sessions, rebase queue, up next, blocked, auth and pause state |
| `GET /api/tasks`, `GET /api/tasks/:id` | Tasks with dependencies and what they unblock |
| `POST /api/tasks`, `PATCH /api/tasks/:id`, `POST /api/tasks/import` | Create, edit, import |
| `POST /api/tasks/:id/{hold,release,retry,discard,approve,top}` | Controls |
| `GET /api/sessions`, `GET /api/sessions/:id/events`, `POST /api/sessions/:id/{stop,message}` | Sessions, timeline, stop, steer |
| `GET /api/tasks/:id/changes?since=base\|round:N` | Changed files with status and line counts |
| `GET /api/tasks/:id/file?path=&side=base\|current`, `GET /api/tasks/:id/tree` | File content and tree (path-safe) |
| `GET /api/tasks/:id/checks`, `GET /api/checks/:id/log`, `POST /api/tasks/:id/checks/rerun` | Checks |
| `GET/POST/DELETE /api/tasks/:id/comments`, `POST /api/findings/:id/dismiss` | Review notes |
| `POST /api/tasks/:id/request-changes` | Body: `{instruction, commentIds, findingIds, includeFailingTest, mode: "resume" \| "fresh"}` |
| `POST /api/tasks/:id/terminal`, `POST /api/terminals/:id/stop` | "Try it" |
| `GET /api/chat`, `POST /api/chat`, `POST /api/chat/stop`, `POST /api/proposals/:id/{confirm,reject}` | Chat |
| `POST /api/pause`, `POST /api/resume` | Scheduler |

### 14.2 WebSocket and MCP

**WebSocket** (`/api/stream`). Event types:
- `task.updated`
- `session.started`, `session.event`, `session.ended`
- `check.updated`, `rebase.updated`
- `terminal.output`
- `chat.message`, `chat.delta`
- `proposal.updated`
- `auth.updated`
- `service.stopping`

Every event carries `taskId` and `sessionId` where relevant, so the UI refreshes only the pane that changed.

**MCP** (`/mcp`, Streamable HTTP, same bearer token). Provides the Conductor tools listed in 6.3.

### 14.3 CLI

```
mastermind [path]                 run in the foreground (default path: .)
  --port <n>  --open
mastermind doctor [path]          checks only: git, claude version, sign-in and plan, attribution setting, config
mastermind status|tasks|logs <task> [-f]|chat "<msg>"     talk to the running instance
mastermind hold|release|retry|discard|approve <task>      same actions as the UI
mastermind import|export <tasks.yaml>
```

## 15. Web UI

### 15.1 Visual style

The palette is **Arctic** (dark): soft slate with frosty blue and peach, for low glare.

| Token | Value |
|---|---|
| Page / panel / raised (selected or hover) background | `#1B1F27` / `#232833` / `#2C3240` |
| Panel border / control border | `#363D4D` / `#4A5266` |
| Text / muted text | `#ECEFF4` / `#AEB6C6` |
| Frost blue: running, primary action, links, added lines | `#88C0D0`, with `#1B1F27` text on it (added-line background `#22394A`) |
| Peach: failed, blocked, needs you, removed lines | `#E8A37C` (removed-line background `#45302A`) |
| Fonts | IBM Plex Sans for the UI; IBM Plex Mono for code, ids and paths |

Design rules:
- 8px radius on panels and 6px on controls.
- Controls at least 44px tall.
- Real `<button>`, `<a>`, `<label>` and `<input>` elements.
- Status is never shown by colour alone; it always has a word or a `+`/`−` marker.
- Monaco uses a theme built from these tokens.
- Layouts are fluid and stack on narrow screens.

### 15.2 Screens

**Top bar** (on every screen):
- the project name
- tabs: Chat, Overview, Tasks, Sessions, Review
- `Running · Max`; its tooltip shows the account and the Ctrl+C note
- a **Pause** button

Banners appear under the top bar only when needed.

1. **Chat (home):** as described in 6.5. A first-run state is included.
2. **Overview:**
   - Count tiles: Remaining, Running, Done, Blocked, plus progress shown as "N of M".
   - Active session cards with task, role, elapsed time, branch, latest action in mono, files changed with `+`/`−`, "View diff" and "Activity". A fixer card shows its attempt number and reason in orange.
   - A right column with Rebase queue, Up next (ready tasks, and waiting tasks with what they wait on) and Needs you.
3. **Tasks:**
   - A board with Remaining, Running, Rebasing and Done columns. Blocked sits under Rebasing. Unmet dependencies show as pills.
   - A side panel with goal, acceptance, "Depends on" with statuses, Unblocks, Touches, and Edit, Move to top and Hold.
   - A second tab shows the dependency graph (React Flow).
4. **Sessions:**
   - Left: active sessions, then sessions finished today.
   - Centre: header (task, role, start time, branch, "View diff", "Stop session"), then a timeline of time, type and summary. Failures are orange and the live row is highlighted.
   - Right: facts (role, model, attempt, elapsed, commits, files, context bar) and the task's goal and acceptance command.
5. **Review, one session:**
   - Session tabs with a status word and file count; "Diff / File" and "One / All" toggles.
   - Left: files grouped by directory, marked `M` or `A`, with an "editing" tag on the file being edited now.
   - Right: read-only Monaco diff with the base commit on the left and the file on disk on the right, labelled "uncommitted" when it is. File mode shows a plain editor and the full tree.
   - The open file refreshes on every `session.event` that edits it.
6. **Review, all sessions:** a two-column grid, one pane per active session. Each pane shows the latest edited file as a compact inline diff and an "Open" button. A pane with a problem gets an orange border and a warning label.
7. **Test and decide** (a task in `review`):
   - Header: "Ready for review · round N", Discard branch, "Request changes · N comments", and the primary "Approve and rebase".
   - Left: the check list with "Re-run all", and the file list with note counts.
   - Centre: the diff, with inline comments and findings in Monaco view zones.
   - Right: "Try it yourself" terminal and a "Failed test" box.
8. **Request changes:**
   - Back link and "this becomes round N+1".
   - "What to send": items with include toggles. Findings are off by default.
   - "Overall instruction".
   - "Who does the work": continue the same session, or start a fresh one.
   - "Send to session" and Cancel.
   - Right: the Rounds history and a live preview of the exact message.
9. **Settings** (opened from the `Running · Max` item in the top bar). One short form per project, saved to `.mastermind/config.yaml`:
   - models for the chat, workers, fixers and reviewer, and whether the reviewer runs
   - worker permissions: bypass, auto or allowlist, plus the allowlist
   - sandbox on or off, with allowed domains
   - parallel workers
   - build, test and setup commands
   - protected paths (`requireReviewFor`)

   The chat can change the same settings, behind a confirmation.

## 16. Claude CLI facts

### 16.1 Verified on Claude Code 2.1.283

**Commands:**
- `claude auth status --json` returns `loggedIn`, `authMethod`, `apiProvider`, `email` and `subscriptionType`.
- `claude auth login [--claudeai]` runs the subscription login flow.
- `claude auth logout` signs out.

**Flags:**
- `-p`, `--model`
- `--output-format stream-json`, `--input-format stream-json`, `--include-partial-messages`, `--verbose`
- `--json-schema`, `--max-turns`
- `--tools`, `--allowedTools`, `--disallowedTools`
- `--permission-mode`
- `--resume`, `--session-id`
- `--append-system-prompt[-file]`
- `--mcp-config`, `--strict-mcp-config`
- `--settings`, `--fallback-model`, `--effort`, `--no-session-persistence`, `--name`

**Never use:**
- `--bare`: API key only.
- `--max-budget-usd`: API only.
- `--dangerously-skip-permissions`. Bypass is requested with `--permission-mode bypassPermissions`, only for worker and fixer sessions, and only with `cwd` set to the task worktree.

### 16.2 M0 spikes

Save the outputs to `test/fixtures/claude-samples/` and write the findings up in `docs/claude-cli-notes.md`.

1. The `stream-json` event shapes (init, assistant `tool_use` and text, `tool_result`, `result` with usage and session id), and whether `--verbose` is required.
2. Where `--json-schema` puts the structured answer.
3. The exit code and text when the usage limit is hit. If it can't be reproduced, back off on any unrecognised non-zero exit.
4. The exact text when an auth token has expired or is invalid. Reproduce it with a revoked `CLAUDE_CODE_OAUTH_TOKEN` in a sandbox `CLAUDE_CONFIG_DIR`.
5. Stream-json input: injecting a message mid-run, and how the process behaves while stdin stays open after `result`.
6. That HTTP MCP with an `Authorization` header works through `--mcp-config`, and that `--tools "Read,Grep,Glob"` keeps MCP tools available.
7. **Headless permissions.** Confirm that `--permission-mode bypassPermissions` runs Bash such as `make test` headless on a subscription (the default, decision 3). Also check how `auto` and `acceptEdits` with `workerAllowedTools` behave, for the other settings.
8. That attribution set through `--settings` suppresses trailers in commits made under `-p`.
9. Process groups: a `detached: true` child does not receive the terminal's SIGINT, and `kill(-pgid)` also takes down tool subprocesses such as `make`.
10. **Sandbox without prompts.** Under `-p` with `bypassPermissions` and the sandbox settings in decision 9, check four things:
    - a write outside the worktree fails
    - an unlisted host is denied and nothing waits for input
    - Edit and Write outside the worktree are blocked by deny rules
    - `failIfUnavailable` stops the session when the sandbox can't start

## 17. Stack and layout

| Area | Choice |
|---|---|
| Base | TypeScript, Node 22.13 or later (the first version with `node:sqlite` unflagged; developed on 26), pnpm workspace (`npm i -g pnpm`) |
| Service | Fastify, `ws`, `node:sqlite`, `execFile("git")`, `yaml`, `zod`, `@modelcontextprotocol/sdk`, `node-pty` (lazy-loaded; only "Try it" needs it) |
| Terminal | Ink and `commander` |
| Web | React, Vite, `@monaco-editor/react`, `xterm`, React Flow |
| Tests | vitest, plus a fake `claude` executable |
| Build | `tsup` bundles the CLI and service; the web build is served statically; development uses `pnpm link --global` |

```
mastermind/
  packages/
    core/   src/{config,db,actions,scheduler,sessions,events,git,checks,rebase,attribution,auth,procs,recovery}.ts
            src/conductor/{runner,mcp,digest}.ts   src/api/{http,ws}.ts
    cli/    src/{index.ts, tui/*.tsx}       # bin: mastermind (foreground runtime)
    web/    src/{screens,components,chat,api,theme}/
  prompts/  conductor.md worker.md fixer.md reviewer.md planner.md refine.md
  docs/     PLAN.md claude-cli-notes.md
  test/     fixtures/{fake-claude,claude-samples/}  integration/
```

## 18. Milestones

Each milestone must be usable and tested before the next starts. Commit at the end of each one, with no attribution.

| # | Deliver | Done when |
|---|---|---|
| 0 | Spikes from 16.2; pnpm workspace; vitest; fake-claude (stream-json in and out, makes commits, optional attribution trailer, usage-limit, auth-expired and hang modes) | `docs/claude-cli-notes.md` answers all 10 spikes; `pnpm test` passes |
| 1 | **Foreground runtime:** `mastermind .`, lock, `doctor`, auth gate with login hand-off, Ink view, Ctrl+C twice kill path, recovery. Config auto-detect, DB, actions, scheduler, session manager, worktrees | 3 fake tasks (2 parallel, 1 dependent) reach `checking` in order. Ctrl+C twice leaves **zero** fake-claude pids in under 500 ms (the test checks `ps`). A restart resumes the killed tasks. Signed out, startup offers login; with an API-key account, startup refuses |
| 2 | Event parser from real samples, WebSocket, MCP server, ChatRunner, `mastermind chat`, `logs -f` | From the terminal, "add a task…" and "what's running?" work with the real Conductor driving fake workers |
| 3 | Web shell, **Chat home** (single column, first-run state), Overview, Sessions, sign-in banner, "stopped" page | Tasks can be created and watched by chat, and one stopped from chat, with no page reload |
| 4 | Git service, Review screens (Monaco), `message_session` steering | An edit in a worktree appears in the diff within a few seconds, before any commit. A steering message changes a live worker's course |
| 5 | Checks, auto-rebase with conflict resolution, rebase queue, fixers, attribution guard, Test and decide (without comments) | A passing task is rebased onto main and fast-forwarded, with no merge commit. A conflicting branch is resolved by a fixer, then rebased onto main. A failing task gets a fixer, then blocks after `maxAttempts`. An injected trailer never reaches main |
| 6 | Comments, findings, Request changes, rounds, resume and fresh modes, "Try it" | A request-changes round trip works from both the UI and chat. The diff can show changes since the previous round |
| 7 | Tasks board, editing, planning through chat (plan list) and import/export, dependency graph | A vision shared in chat becomes an imported, valid task graph |
| 8 | Polish: Conductor rollover, `wakeOnEvents`, auth-expiry end to end, a clean install from the repo | A chat lasting a day stays coherent. An expired sign-in mid-run recovers through the terminal prompt. Install works on a clean machine |

## 19. Testing

- **Unit tests:**
  - scheduler readiness and touches-overlap
  - DAG validation
  - event parser against recorded samples
  - auth status classifier, including every refusal case
  - environment cleaner
  - attribution scanner and rewriter
  - path safety
  - proposal gating
  - the two-press Ctrl+C state machine
- **Integration tests.** Each test uses a temporary git repo and fake-claude and runs the full lifecycle, including the kill path and recovery. Tests never call the real `claude`.
- **Live tests.** An opt-in `pnpm test:live` script checks Conductor prompt quality with the real CLI. It never runs in CI.
- **Web tests.** vitest and Testing Library cover the stores and reducers. One Playwright smoke test covers chat → task → diff.

## 20. Risks

| Risk | Mitigation |
|---|---|
| A bypass-mode worker runs something harmful | Workers run inside their own worktree; the owner can switch to `auto` or `allowlist`, with the sandbox containing it by default (decision 9) |
| Pro limits are low | 1 worker on Pro, judge on haiku, the chat model switchable to sonnet, global back-off with a visible resume time |
| Orphaned processes after a hard kill | Every child in its own process group, pids and pgids stored, reaped at startup |
| The Conductor takes an unwanted action | No shell or edit tools; irreversible actions need a click; every action shown as a card |
| Prompt injection from repo content | Same mitigations; the Conductor's reads cannot become writes |
| Sign-in expires during a long run | Periodic checks, a paused scheduler, and a terminal prompt; no attempts are lost |
| Context bloat in a long chat | Summary rollover; history kept in the database |
| Claude CLI output changes between versions | A minimum version, contract tests against recorded `stream-json` samples, a defensive parser, and a `doctor` warning on untested versions |
| A web page attacks the local server (DNS rebinding, CSRF) | Bind to 127.0.0.1, require the bearer token on every route, and reject requests whose `Host` or `Origin` isn't localhost |
| Worker sessions run code on the owner's machine | Claude Code's sandbox is on by default: writes limited to the worktree, network limited to an allowlist, no prompts (decision 9) |
| Worktrees and parallel builds use disk and CPU | `commands.setup` per worktree, cleanup after rebasing onto main or discarding, one check pipeline at a time |
| Logs hold code and command output, possibly secrets | Logs stay in `.mastermind/` (excluded from git) with a retention setting, 30 days by default |
| Anthropic's terms on subscription use | Mastermind only runs the **unmodified** `claude` binary, each user signs in through Anthropic's own flow, and mastermind never reads, stores or forwards tokens. Pro and Max limits assume ordinary individual use, so worker defaults stay modest. Before sharing or publishing, re-read the Consumer Terms and Claude Code's legal page, and ask Anthropic if unsure. Never host mastermind for others on one login, and never put "Claude" in the product name. |

## 21. Out of scope for now

- API keys, Console billing, Bedrock, Vertex and Foundry
- Team and Enterprise plans (revisit later)
- Native Windows (WSL works as Linux)
- Electron or VS Code packaging
- Running in the background after the terminal closes
- Multiple users, remote access, or running sessions on other machines
- Sharing or publishing mastermind (revisit only after checking Anthropic's terms)

## 22. Owner decisions (all decided 2026-10-05; 20–22 from the final review)

1. **Chat model — decided:** default to **opus**; the owner can switch models from the chat input (a small model menu) and in `config.yaml`. The choice persists per project.
2. **Rebasing onto main — decided:** mastermind **rebases** onto main and fast-forwards; it never creates merge commits. Conflicts during rebase are resolved automatically by a fixer session. Tasks that pass every check are rebased onto main automatically (`autoRebase: true`); only paths listed in `requireReviewFor` (empty by default) wait for the owner. (Confirmed: passing tasks are rebased onto main without approval.)
3. **Worker permissions — decided:** workers **bypass permission prompts inside their own worktree** by default (`workerPermissions: bypass`). The owner can change this in mastermind (a Settings panel, the chat, or `config.yaml`) to `auto` or `allowlist`, with `workerAllowedTools` for the allowlist.
4. **Worktree location — decided:** a **central folder**, `~/.mastermind/worktrees/<repo>-<hash>/<task>`. Each one is a local clone (decision 20). The short hash of the repo path keeps two repos with the same name apart. `mastermind doctor` reports the disk space used, and worktrees are removed when a task is rebased onto main or discarded.
5. **Plans — decided:** **Pro and Max only.** Team and Enterprise get the "subscriptions only" message for now; widening later is a one-line change in the auth classifier.
6. **Owner's checkout — decided:** mastermind **asks the owner to work on another branch**. At startup, if the checkout is on main, it offers to switch to a new branch (default `dev`) or an existing one (step 4a). Rebasing onto main then moves the `main` ref directly and never touches the owner's working files. If the owner switches back to main mid-run, rebasing onto main pauses until they switch away.
7. **Remote — decided:** **stay local.** Mastermind never pushes, fetches or opens PRs. The owner pushes main when ready. If `main` has an upstream, the chat can mention how many commits it is ahead, but takes no action.
8. **Platforms — decided:** **macOS and Linux.** Both use the same process-group and signal model, so Ctrl+C twice and cleanup behave the same. Windows is out of scope for now; WSL counts as Linux. CI runs the test suite on both.
9. **Sandbox — decided (revised 2026-10-05):** **on by default, and it never prompts.** Workers and fixers get Claude Code's sandbox through `--settings`:
   ```json
   "sandbox": { "enabled": true, "autoAllowBashIfSandboxed": true, "allowUnsandboxedCommands": false,
                "failIfUnavailable": true,
                "network": { "allowedDomains": [...], "strictAllowlist": true },
                "filesystem": { "allowWrite": [...] } }
   ```
   - **What it does.** Commands inside the sandbox run without asking. There is no "run outside the sandbox?" escape. Unknown hosts are denied rather than asked about. Writes are limited to the worktree plus `allowWrite`. If the sandbox can't start (on Linux it needs `bubblewrap` and `socat`), the session fails instead of running unprotected, and `mastermind doctor` reports it.
   - **Presets.** Mastermind detects the toolchain (npm/pnpm/yarn, cargo, go, pip/uv) and pre-fills its package registries in `allowedDomains` and its cache folders in `allowWrite`.
   - **Blocked access.** Denials are silent. Only when a task actually fails because something was blocked does the chat offer it once, for example "vfs-cache couldn't reach github.com. Allow it for this project?" with **Allow** and **Not now**. Allowed entries are saved to config.
   - **Turning it off.** Settings can turn the sandbox off per project.
   - **To verify in M0.** Confirm that Claude Code's file tools (Edit and Write), which follow permission rules rather than the sandbox, stay inside the worktree under `bypassPermissions` with deny rules. If they don't, mastermind adds its own path guard.
10. **Distribution — decided:** **private for now.** Install from this repo with `pnpm build && pnpm link --global`, which puts `mastermind` on PATH. There is no npm name and no licence yet; publishing is revisited once it's stable. M8's packaging work becomes "install works on a clean machine from the repo".
11. **Language — decided:** **TypeScript everywhere**: CLI and orchestrator (Node, with Ink for the terminal view), and the web app (React). They share types and zod schemas.
12. **Colour palette — decided:** **Arctic** (dark), as in 15.1.
13. **Commit history — decided:** each task reaches main as **one squashed commit**, with a message mastermind writes (1a in 9.3). Worker, fixer and WIP commits are kept only on the task branch until it is deleted.
14. **The owner's own branch — decided:** **mastermind rebases it onto main on request.**
   - **Rebasing it.** The owner says "rebase my branch" in the chat, or clicks **Rebase** on it. The owner's checkout must be clean; if it isn't, mastermind asks them to commit first.
     - Mastermind rebases a detached copy of the branch onto main in a temporary worktree.
     - It runs the same checks as a task, then fast-forwards main. The owner's commits are **kept as they are**, with their own messages, and are not squashed (decision 22). If a fixer had to resolve conflicts, its changes are folded into the owner's commit where the conflict happened, so no AI-written commit appears.
     - It then moves the owner's branch to the new main with `git reset --keep` in their checkout.
     - Conflicts go to a fixer session, as for tasks.
   - **Keeping it current.** When main moves, the chat offers "main moved 3 commits; rebase dev onto it?". It only does so after the owner confirms and the checkout is clean.
15. **Usage — decided:** keep the defaults: **Opus** workers and fixers, a **Sonnet reviewer on every task**, and Haiku for small judgements. Settings can change the model for each role and turn the reviewer off (`reviewer: { enabled: true }`).
16. **Notifications — decided:** a **desktop notification** whenever an event needs the owner: blocked, sign-in needed, a protected task waiting for review, or a usage-limit pause.
   - If a browser tab is open, the web app shows it with the browser Notification API (permission asked once), and clicking it opens the right screen.
   - If no tab is connected, the service sends a native notification itself: `osascript` on macOS, `notify-send` on Linux.
   - Settings has an on/off toggle (`notifications: { desktop: true }`).
17. **Long-running sessions — decided:** there is **no hard time limit**. After 60 minutes (`stuckCheck.after`), mastermind checks whether the session is really stuck, then repeats the check every 20 minutes (`stuckCheck.every`) while it runs.
   - **The check.** Plain-code signals come first:
     - minutes since the last edit, commit or new output
     - the same command failing again and again
     - the same file edited back and forth
     - a single command running for a long time with no output

     These, plus the last 50 event summaries, go to a judge call (sonnet, `--json-schema`) that returns `{stuck, reason, suggestion}`.
   - **Not stuck:** keep waiting. The session's activity view shows "checked at 61 min: still making progress".
   - **Stuck:** kill the session's process group and save its work as a WIP commit. Start a **fresh** session, not a resumed one, so the bad context doesn't carry over. Its prompt includes the task, the current diff, and "the previous attempt got stuck: <reason>. Try a different approach: <suggestion>". This counts as an attempt, so `maxAttempts` still ends in `blocked`. The chat gets one line, for example `ext2-driver was stuck looping on make test; restarted with a different approach`.
18. **Commit author — decided:** the **owner's own git identity** (`user.name` and `user.email`) is the author and committer of every commit mastermind makes or rebases onto main. Nothing marks a commit as written by mastermind or Claude.
19. **Wording — decided:** the action that puts work on main is called **Rebase** everywhere: buttons, chat, status names, config and code. Never "Land" and never "Merge". The task status is `rebasing`, the queue is the rebase queue, the button is **Rebase** or **Approve and rebase**, the chat says "Rebase sched-prio onto main?", and the config key is `autoRebase`.
20. **Isolation — decided:** each task works in its own **local clone** (`git clone --local`, hard-linked) under the central folder from decision 4, with no remote pointing back. Workers, sandboxed or not, can't move main or touch the owner's branches. Mastermind fetches finished work into the owner's repo itself (8.2, 9.3).
21. **Reviewer findings — decided:** the reviewer tags each finding `minor` or `serious`. **Serious findings go to a fixer automatically**, and checks and review then run again. Minor findings are informational and can be read in Sessions. The owner only gets involved if the task is still failing after `maxAttempts`, when it becomes `blocked` and triggers a notification. If `reviewer.enabled` is off, nothing blocks on review.
22. **The owner's commits — decided:** when the owner's own branch is rebased onto main, **their commits are kept as they are**. Squashing applies only to mastermind's task commits.
