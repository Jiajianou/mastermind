# Mastermind

Mastermind runs many headless Claude Code sessions in parallel against one git repository, and you drive it
through a chat.

You describe what you want, and mastermind turns it into a graph of small tasks. Each task runs in its own
Claude Code session and its own local clone of the repo, in parallel where the graph allows. Mastermind checks
each result with your build and test commands, has it reviewed, lets you review it and request changes, and
rebases finished work onto your main branch as one commit per task. It never pushes, fetches or opens pull
requests, and never creates merge commits.

Everything runs on your machine. One command starts it in a repo and serves a local web app for that repo.

## Requirements

- macOS or Linux (WSL counts as Linux). On Linux the sandbox needs `bubblewrap` and `socat`.
- Node.js 22.13 or later.
- pnpm (`npm install --global pnpm`, or `corepack enable`).
- git.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) 2.1.283 or later, on your PATH as `claude`.
- A **Claude Pro or Max subscription**, signed in to Claude Code with your claude.ai account. API keys, Console
  billing, Bedrock, Vertex and Team or Enterprise plans are not supported. Mastermind never stores credentials;
  sign-in belongs to Claude Code.

## Install

From a clone of this repository:

```sh
pnpm install
pnpm build
pnpm add --global "link:$PWD/packages/cli"
```

The last line puts `mastermind` on your PATH. It does what `pnpm link --global` does on older pnpm versions;
pnpm 12, which this repo pins, no longer has that form. If pnpm says its global bin directory is not on your
PATH, run `pnpm setup` once and open a new terminal. After pulling new changes, run `pnpm install && pnpm build` again; the link stays in place.

Check the machine is ready:

```sh
mastermind doctor ~/code/myproject
```

Doctor checks git, the Claude Code version, the sign-in and plan, Claude's attribution setting, the project
config, the disk used by task clones, the logs and the sandbox. It changes nothing.

## Run

```sh
cd ~/code/myproject
mastermind .
```

Mastermind checks your Claude sign-in (and starts Claude Code's own login if needed), asks you to move off the
main branch if you are on it, writes `.mastermind/config.yaml` on the first run, and prints a link such as
`http://127.0.0.1:4700/#t=…`. Open it to reach the chat. Use `--port <n>` to pick the port and `--open` to open the
browser for you.

The terminal stays in the foreground and shows what is running. **Press Ctrl+C twice to stop mastermind and kill
every session it started.** Closing the terminal does the same. The next start recovers anything that was
interrupted.

While it runs, other terminals can talk to it:

```sh
mastermind status
mastermind tasks
mastermind logs <task> -f
mastermind chat "what's running?"
mastermind hold|release|retry|approve|discard <task>
mastermind import|export tasks.yaml
```

Mastermind keeps its state in `.mastermind/` in your repo (excluded from git) and task clones in
`~/.mastermind/worktrees/`. Logs older than `logRetention` (30 days by default) are deleted at startup. Settings in
the web app, `.mastermind/config.yaml` and an optional committed `mastermind.yaml` configure it.

## Development

```sh
pnpm install
pnpm verify          # format, lint, typecheck, unit/web/integration tests, build, end-to-end tests
pnpm test:live       # opt-in: checks Conductor prompts against the real claude CLI; never runs in CI
pnpm smoke:install   # clones the last commit, installs, builds, links into a temp prefix and runs doctor
```

Tests never call the real `claude`; they use `test/fixtures/fake-claude`. `pnpm test:live` is the only exception,
and it uses your real sign-in and subscription limit.

`docs/PLAN.md` is the design and the source of truth. `docs/implementation-notes.md` records decisions made while
building, and `docs/claude-cli-notes.md` records how the `claude` CLI actually behaves.

## Architecture

Mastermind is one Node process that supervises every child process. Each child runs in its own process group so
Ctrl+C twice can kill it outright.

- **`packages/core`**: the orchestrator. SQLite (`node:sqlite`) holds all state; git holds all work. A single
  action layer is the only writer, and the HTTP API, the Conductor's MCP tools and the CLI all call it. Around it:
  the scheduler, the session manager (`claude -p` with stream-json), the git service, the checks pipeline, the
  rebase queue, the auth guard and recovery. Shared zod contracts live in `@mastermind/core/contracts`.
- **`packages/cli`**: the `mastermind` binary. It runs the startup sequence, the Ink terminal view and the Ctrl+C
  kill path, and serves the web app. Its build bundles core, the web app and `prompts/` into `dist/`.
- **`packages/web`**: the React web app: the chat home, overview, tasks board, sessions, review and settings.
- **`prompts/`**: system prompts for the Conductor, workers, fixers, the reviewer and planning.

The **Conductor** is a Claude Code session that drives the chat. It cannot edit files or run commands; it acts
only through mastermind's MCP tools, and irreversible actions wait for your click. Workers and fixers run in their
own clones inside Claude Code's sandbox, so they cannot move main or touch your branches.
