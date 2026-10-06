# Mastermind

A local orchestrator for headless Claude Code sessions. Run `mastermind .` in a git repo. It runs in the foreground, and pressing Ctrl+C twice kills everything. It serves a chat-first web UI. `docs/PLAN.md` is the source of truth for the design and the build order.

## Rules

- **Follow the owner's decisions** in `docs/PLAN.md` section 22. Don't re-ask them or change them without asking.
- **No AI attribution in git.** Never add `Co-Authored-By: Claude`, "Generated with Claude Code", `Claude-Session:` or any similar trailer or footer to commits or PR descriptions in this repo. Mastermind must also never let such lines reach the main branch of a project it manages (PLAN.md section 11).
- **Claude Pro and Max subscriptions only.** Every LLM call goes through the `claude` CLI on a claude.ai subscription sign-in. Mastermind never stores credentials. Clean the environment of every child (PLAN.md 4.4). Never use `--bare`, which forces API-key auth.
- Every child process is spawned in its own process group (`detached: true`), with its pid and pgid recorded, so that pressing Ctrl+C twice can kill it with SIGKILL.
- Tests never call the real `claude`. Use `test/fixtures/fake-claude`. Never run `claude auth login`, `claude auth logout` or `claude setup-token` against the owner's real Claude config.

## Code standards

- **Types are strict and explicit.** No `any` (lint error). Prefer `unknown` plus narrowing. No `as` casts or `!` non-null assertions except at a boundary that was just validated. Model states and events as discriminated unions and string literal unions derived from zod enums.
- **Validate at every boundary with zod:** config files, HTTP and MCP input, WebSocket messages, `claude` stream-json lines, CLI output we parse, and JSON columns read from SQLite. Shared contracts live in `@mastermind/core/contracts` (browser-safe, no Node imports) and are used by core, CLI and web alike.
- **No comments unless they are truly needed.** Code should explain itself through names and structure. A comment is only for a non-obvious *why* (a CLI quirk, a race, a platform difference). No JSDoc boilerplate, no commented-out code, no TODOs left behind.
- **Organise for a human reader.** Small modules with one clear responsibility, descriptive names, named exports, shallow call chains, no dead code, no speculative abstractions. Keep side effects (processes, git, filesystem, clock) behind small injectable interfaces so logic stays pure and testable.
- Errors are typed and handled deliberately; never swallow an error silently.
- Formatting is Prettier's; `pnpm verify` must pass before any work is considered done.

## Testing standards

Fewer, robust, meaningful tests beat many small trivial ones.

- Test behaviour through public interfaces, the way callers use the code. Don't test private helpers, constants, trivial getters, or what the type checker already guarantees. No large snapshot dumps.
- Each test states one behaviour in its name and asserts real outcomes (state in SQLite, commits in git, processes in `ps`, events emitted, text on screen).
- Prefer table-driven tests for classifiers, parsers and state machines, and cover failure and refusal paths, not just the happy path.
- **Unit** (`packages/*/src/**/*.test.ts`): pure logic such as the scheduler, DAG validation, parsers, classifiers, the attribution scanner, path safety, proposal gating, the Ctrl+C state machine, and web reducers.
- **Integration** (`test/integration/`): real temp git repos, real SQLite, real child processes with fake-claude. Mock only the true external boundaries: `claude` (fake-claude) and OS notifications.
- **End to end** (`test/e2e/`): the built `mastermind` binary, plus Playwright specs in `test/e2e/web/` for user-visible flows. Use these where a real user flow is at stake, not for every function.
- Tests are deterministic and isolated: temp HOME and worktree folders, fake timers or wait-for-condition helpers instead of fixed sleeps, and every spawned process and temp dir is cleaned up.

## How this repo is built

`./implement.sh` builds the project from `tasks.yaml`, one unattended Claude Code session per task, with no human input. Each task works on branch `impl/<id>`. The runner then runs a review session, checks the work with `gate` plus the task's `acceptance` command, squashes the branch into one commit (whose body ends with `Task: <id>`) and rebases it onto main. A task that keeps failing gets fresh rescue sessions that look for the root cause anywhere in the repo. If it is still blocked after those, the whole run stops.

- When working inside a task session: stay on the task branch, commit with plain messages, never push, rebase, reset or switch branches, and don't edit `tasks.yaml`, `implement.sh` or `.implement/`.
- Nobody answers questions during a run. Make sound decisions consistent with `docs/PLAN.md`, and record notable decisions and deviations in `docs/implementation-notes.md` so later sessions see them.
- Findings from the Claude CLI spikes live in `docs/claude-cli-notes.md`. Read it before touching anything that spawns or parses `claude`.
