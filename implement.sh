#!/usr/bin/env bash
# Builds Mastermind unattended: every task in tasks.yaml becomes its own Claude Code session.
# Per task: implement -> gate + acceptance (with fix rounds) -> review -> gate again -> squash -> rebase onto main.
# A task that still fails gets rescue sessions; if it stays blocked, the whole run stops.
# Re-running is safe: finished tasks are skipped and an interrupted task resumes from its impl/<id> branch.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./implement.sh [options]

Runs each task in tasks.yaml as an unattended Claude Code session. A finished task is squashed
into one commit and rebased onto main. A task that keeps failing gets rescue sessions; if it is
still blocked after those, the run stops. Re-running resumes where the last run stopped.

Options:
  --list          Show every task and its state, then exit
  --only <id>     Run only this task (its dependencies must be done)
  --until <id>    Stop after this task
  --dry-run       Write the prompts to .implement/prompts/ and print the run order, without running Claude
  --no-review     Skip the review session after each task
  -h, --help      Show this help

Environment (defaults in brackets):
  MODEL [opus]            Model for implement and fix sessions
  REVIEW_MODEL [$MODEL]   Model for review sessions
  MAX_FIXES [4]           Fix rounds per phase before escalating
  MAX_RESCUES [2]         Fresh rescue sessions before a task counts as blocked and the run stops
  MAX_RETRIES [4]         Retries of a session that crashes or stalls
  IDLE_TIMEOUT [2700]     Seconds without session output before it counts as stalled
  SESSION_TIMEOUT [28800] Hard limit for one session, in seconds
  GATE_TIMEOUT [5400]     Hard limit for one gate run, in seconds
  LIMIT_POLL [1200]       Seconds between checks while waiting out a usage limit
  MAIN_BRANCH [main]      Branch that finished work is rebased onto
  CLAUDE_BIN [claude]     The claude executable
  TASKS_FILE [tasks.yaml]
EOF
}

MODEL=${MODEL:-opus}
REVIEW_MODEL=${REVIEW_MODEL:-$MODEL}
MAX_FIXES=${MAX_FIXES:-4}
MAX_RESCUES=${MAX_RESCUES:-2}
MAX_RETRIES=${MAX_RETRIES:-4}
IDLE_TIMEOUT=${IDLE_TIMEOUT:-2700}
SESSION_TIMEOUT=${SESSION_TIMEOUT:-28800}
GATE_TIMEOUT=${GATE_TIMEOUT:-5400}
LIMIT_POLL=${LIMIT_POLL:-1200}
MAIN=${MAIN_BRANCH:-main}
CLAUDE_BIN=${CLAUDE_BIN:-claude}

CLAUDE_SETTINGS='{"attribution":{"commit":"","pr":"","sessionUrl":false}}'
ATTRIBUTION_RE='^[[:space:]]*co-authored-by:.*(claude|anthropic)|generated with \[?claude code|^[[:space:]]*claude-session:|noreply@anthropic\.com'
LIMIT_RE='usage limit|hit your limit|limit reached|limit will reset|rate.?limit|resets (at )?[0-9]'
AUTH_RE='not logged in|please run /login|authentication failed|invalid api key|oauth token (has )?(expired|revoked)|401|unauthorized'

LIST_ONLY=0
DRY_RUN=0
REVIEW=1
ONLY=""
UNTIL=""

ROOT=""
STATE=""
TASKS_JSON=""
RUN_STAMP=$(date '+%Y%m%d-%H%M%S')
CHILD=""
SUPERVISE_TIMEOUT=""
SESSION_ID=""
FAILURE_NOTE=""
LAST_GATE_LOG=""
CLEAN=(env -u CLAUDECODE)

ACTIVITY_JQ=$(
  cat <<'EOF'
def clip($n): gsub("\\s+"; " ") | if length > $n then .[0:$n] + "…" else . end;
fromjson? | select(.type == "assistant") | .message.content[]? |
  if .type == "tool_use" then
    "\(.name) " + ((.input.file_path // .input.path // .input.command // .input.pattern
                    // .input.description // .input.url // "") | tostring | ltrimstr($root) | clip(110))
  elif .type == "text" then "» " + (.text | clip(130))
  else empty end
| "  \(now | strflocaltime("%H:%M:%S"))  \($label)  \(.)"
EOF
)

TASKS_MJS=$(
  cat <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";

const [input, output] = process.argv.slice(2);
const fail = (message) => {
  console.error(`tasks.yaml: ${message}`);
  process.exit(1);
};

const doc = YAML.parse(readFileSync(input, "utf8"));
if (!doc || typeof doc.gate !== "string" || !Array.isArray(doc.tasks)) {
  fail('expected a top-level "gate" string and a "tasks" list');
}

const byId = new Map();
doc.tasks.forEach((task, index) => {
  for (const key of ["id", "title", "goal", "acceptance"]) {
    if (typeof task?.[key] !== "string" || task[key].trim() === "") fail(`task #${index + 1} needs "${key}"`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(task.id)) fail(`invalid id "${task.id}"`);
  if (byId.has(task.id)) fail(`duplicate id "${task.id}"`);
  byId.set(task.id, {
    id: task.id,
    title: task.title.trim(),
    milestone: String(task.milestone ?? ""),
    deps: task.deps ?? [],
    touches: task.touches ?? [],
    goal: task.goal.trim(),
    tests: (task.tests ?? "").trim(),
    acceptance: task.acceptance.trim(),
  });
});

for (const task of byId.values()) {
  for (const dep of task.deps) if (!byId.has(dep)) fail(`${task.id} depends on unknown task "${dep}"`);
}

const ordered = [];
const placed = new Set();
while (ordered.length < byId.size) {
  const next = [...byId.values()].find((t) => !placed.has(t.id) && t.deps.every((d) => placed.has(d)));
  if (!next) fail(`dependency cycle among: ${[...byId.keys()].filter((id) => !placed.has(id)).join(", ")}`);
  ordered.push(next);
  placed.add(next.id);
}

writeFileSync(output, JSON.stringify({ gate: doc.gate.trim(), tasks: ordered }, null, 2));
EOF
)

log() {
  local line
  line="$(date '+%H:%M:%S') $*"
  printf '%s\n' "$line"
  if [ -n "$STATE" ]; then printf '%s\n' "$line" >> "$STATE/implement.log" 2>/dev/null || true; fi
}

die() {
  log "error: $*"
  exit 1
}

now() { date +%s; }

fmt_epoch() { date -r "$1" '+%a %H:%M' 2>/dev/null || date -d "@$1" '+%a %H:%M'; }

notify() {
  local title=${1//\"/} message=${2//\"/}
  if command -v osascript > /dev/null 2>&1; then
    osascript -e "display notification \"$message\" with title \"$title\"" > /dev/null 2>&1 || true
  elif command -v notify-send > /dev/null 2>&1; then
    notify-send "$title" "$message" > /dev/null 2>&1 || true
  fi
}

sleep_until() {
  while [ "$(now)" -lt "$1" ]; do sleep 20; done
}

build_clean_env() {
  local name
  for name in $(compgen -e); do
    case "$name" in
      CLAUDE_CODE_OAUTH_TOKEN | CLAUDE_CONFIG_DIR) ;;
      ANTHROPIC_* | CLAUDE*) CLEAN+=(-u "$name") ;;
    esac
  done
}

kill_child() {
  [ -n "$CHILD" ] || return 0
  kill -TERM -- "-$CHILD" 2> /dev/null || true
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 "$CHILD" 2> /dev/null || break
    sleep 1
  done
  kill -KILL -- "-$CHILD" 2> /dev/null || true
}

on_signal() {
  trap - INT TERM HUP
  printf '\n'
  log "Stopping…"
  kill_child
  log "Stopped. Work in progress stays on its impl/<task> branch. Run ./implement.sh again to resume."
  exit 130
}

show_activity() {
  sed -n "$2,$3p" "$1" | jq -R -r --arg root "$ROOT/" --arg label "$4" "$ACTIVITY_JQ" 2> /dev/null || true
}

# supervise <stdin> <stdout> <stderr> <idle-seconds> <hard-seconds> <activity-label|""> <command...>
# Runs the command in its own process group, kills the whole group on a timeout or once it exits.
supervise() {
  local input=$1 out=$2 err=$3 idle=$4 hard=$5 label=$6
  shift 6
  : > "$out"
  perl -e 'setpgrp(0, 0); exec @ARGV or die "cannot run $ARGV[0]: $!\n"' -- "$@" < "$input" > "$out" 2> "$err" &
  CHILD=$!
  SUPERVISE_TIMEOUT=""
  local start last seen=0 lines t rc=0
  start=$(now)
  last=$start
  while kill -0 "$CHILD" 2> /dev/null; do
    sleep 3
    lines=$(wc -l < "$out" | tr -d ' ')
    if [ "$lines" -gt "$seen" ]; then
      if [ -n "$label" ]; then show_activity "$out" $((seen + 1)) "$lines" "$label"; fi
      seen=$lines
      last=$(now)
    fi
    t=$(now)
    if [ $((t - last)) -ge "$idle" ]; then SUPERVISE_TIMEOUT=idle; fi
    if [ $((t - start)) -ge "$hard" ]; then SUPERVISE_TIMEOUT=hard; fi
    if [ -n "$SUPERVISE_TIMEOUT" ]; then
      kill_child
      break
    fi
  done
  wait "$CHILD" || rc=$?
  kill -KILL -- "-$CHILD" 2> /dev/null || true
  CHILD=""
  lines=$(wc -l < "$out" | tr -d ' ')
  if [ -n "$label" ] && [ "$lines" -gt "$seen" ]; then show_activity "$out" $((seen + 1)) "$lines" "$label"; fi
  return "$rc"
}

auth_ok() {
  "${CLEAN[@]}" "$CLAUDE_BIN" auth status --json 2> /dev/null |
    jq -e '.loggedIn == true and .authMethod == "claude.ai"' > /dev/null 2>&1
}

wait_for_auth() {
  log "Claude Code is not signed in with a claude.ai subscription."
  log "Run 'claude' in another terminal and sign in with /login. This run continues by itself afterwards."
  notify "implement.sh" "Claude sign-in needed to continue"
  until auth_ok; do sleep 60; done
  log "Signed in again. Continuing."
}

probe_claude() {
  local dir="$STATE/probe"
  mkdir -p "$dir"
  printf 'Reply with the single word OK.\n' > "$dir/prompt"
  supervise "$dir/prompt" "$dir/out.json" "$dir/err" 300 300 "" \
    "${CLEAN[@]}" "$CLAUDE_BIN" -p --model "$MODEL" --output-format json || return 1
  jq -e '.is_error == false' "$dir/out.json" > /dev/null 2>&1
}

wait_for_usage() {
  local reset=$1 wake
  case "$reset" in '' | *[!0-9]*) reset=0 ;; esac
  if [ "${#reset}" -ge 13 ]; then reset=$((reset / 1000)); fi
  if [ "$reset" -gt "$(now)" ]; then wake=$((reset + 60)); else wake=$(($(now) + 300)); fi
  notify "implement.sh" "Usage limit reached. Waiting until $(fmt_epoch "$wake")"
  while :; do
    log "Usage limit reached. Waiting until $(fmt_epoch "$wake")…"
    sleep_until "$wake"
    if probe_claude; then
      log "Usage is available again."
      return 0
    fi
    wake=$(($(now) + LIMIT_POLL))
  done
}

session_id_of() {
  jq -R -r 'fromjson? | .session_id? // empty' "$1" 2> /dev/null | tail -n 1
}

# Prints one of: ok | limit <reset-epoch or 0> | auth | stalled | error
classify_run() {
  local out=$1 err=$2 rc=$3 result is_error text reset
  if [ -n "$SUPERVISE_TIMEOUT" ]; then
    echo stalled
    return
  fi
  result=$(jq -R -c 'fromjson? | select(.type == "result")' "$out" 2> /dev/null | tail -n 1)
  is_error=$(printf '%s' "$result" | jq -r 'if .is_error == false then "false" else "true" end' 2> /dev/null || echo true)
  if [ "$rc" -eq 0 ] && [ -n "$result" ] && [ "$is_error" = false ]; then
    echo ok
    return
  fi
  reset=$(jq -R -r 'fromjson? | select(.type == "rate_limit_event") | .rate_limit_info?
                    | select(.status? == "rejected") | .resetsAt? // empty' "$out" 2> /dev/null | tail -n 1)
  if [ -n "$reset" ]; then
    echo "limit $reset"
    return
  fi
  text=$(
    printf '%s' "$result" | jq -r '.result? // empty' 2> /dev/null || true
    jq -R -r 'fromjson? | select(.type == "assistant" and .error? != null) | .message.content[]? | .text? // empty' "$out" 2> /dev/null || true
    tail -n 40 "$err" 2> /dev/null || true
  )
  if printf '%s' "$text" | grep -Eiq "$LIMIT_RE"; then
    reset=$(printf '%s' "$text" | grep -Eo '[|][0-9]{10,13}' | tr -d '|' | tail -n 1 || true)
    echo "limit ${reset:-0}"
    return
  fi
  if printf '%s' "$text" | grep -Eiq "$AUTH_RE" || ! auth_ok; then
    echo auth
    return
  fi
  echo error
}

continue_prompt() {
  local reason=$1 file=$2
  {
    printf 'Your previous run of this task was interrupted (%s).\n' "$reason"
    if [ "$reason" = stalled ]; then
      printf 'It produced no output for a long time, so it was stopped. Avoid commands that run silently for long:\n'
      printf 'no watch modes, foreground dev servers, or interactive prompts.\n'
    fi
    printf 'Check `git status` and `git log`, then continue where you left off and finish the task.\n'
  } > "$file"
}

# run_session <task> <label> <prompt-file> <model> [resume-session-id]
run_session() {
  local id=$1 label=$2 input=$3 model=$4 resume=${5:-}
  local dir="$STATE/logs/$id/$RUN_STAMP" n=0 failures=0 rc verdict out err sid
  SESSION_ID=$resume
  while :; do
    n=$((n + 1))
    out="$dir/$label-$n.jsonl"
    err="$dir/$label-$n.err"
    local args=(-p --model "$model" --permission-mode bypassPermissions
      --output-format stream-json --verbose --settings "$CLAUDE_SETTINGS")
    if [ -n "$resume" ]; then args+=(--resume "$resume"); fi
    log "▶ $id · $label${resume:+ (resumed session)}"
    rc=0
    supervise "$input" "$out" "$err" "$IDLE_TIMEOUT" "$SESSION_TIMEOUT" "$id" \
      "${CLEAN[@]}" "$CLAUDE_BIN" "${args[@]}" || rc=$?
    sid=$(session_id_of "$out")
    if [ -n "$sid" ]; then SESSION_ID=$sid; fi
    verdict=$(classify_run "$out" "$err" "$rc")
    case "$verdict" in
      ok)
        log "✓ $id · $label finished"
        return 0
        ;;
      limit*) wait_for_usage "${verdict#limit }" ;;
      auth) wait_for_auth ;;
      *)
        failures=$((failures + 1))
        log "✗ $id · $label: $verdict (exit $rc). Log: $out"
        if [ "$failures" -gt "$MAX_RETRIES" ]; then return 1; fi
        sleep $((60 * failures * failures))
        ;;
    esac
    if [ -n "$SESSION_ID" ]; then
      resume=$SESSION_ID
      input="$dir/$label-$n.continue.md"
      continue_prompt "${verdict%% *}" "$input"
    fi
  done
}

tf() {
  jq -r --arg id "$1" --arg key "$2" \
    '.tasks[] | select(.id == $id) | .[$key] | if type == "array" then (if length == 0 then "none" else join(", ") end) else tostring end' \
    "$TASKS_JSON"
}

task_ids() { jq -r '.tasks[].id' "$TASKS_JSON"; }

gate_command() { jq -r '.gate' "$TASKS_JSON"; }

is_done() {
  [ -n "$(git log "$MAIN" -E --grep="^Task: $1\$" --format=%H -n 1)" ]
}

done_list() {
  local id list=""
  for id in $(task_ids); do
    if is_done "$id"; then list="$list $id"; fi
  done
  echo "${list:- none}"
}

unmet_deps() {
  local dep missing=""
  for dep in $(jq -r --arg id "$1" '.tasks[] | select(.id == $id) | .deps[]' "$TASKS_JSON"); do
    if ! is_done "$dep"; then missing="$missing $dep"; fi
  done
  echo "$missing"
}

commit_wip() {
  if [ -n "$(git status --porcelain)" ]; then
    git add -A
    git commit -q --no-verify -m "WIP: $1 $2"
  fi
}

restore_branch() {
  local id=$1 branch="impl/$1" main_before=$2 current stray main_now
  if [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; then
    git rebase --abort > /dev/null 2>&1 || true
  fi
  current=$(git symbolic-ref -q --short HEAD || echo "a detached HEAD")
  if [ "$current" != "$branch" ]; then
    log "! session left $branch for $current; moving its work back"
    commit_wip "$id" "stray work"
    stray=$(git rev-parse HEAD)
    git switch -q "$branch" || die "could not return to $branch"
    if git merge-base --is-ancestor "$branch" "$stray"; then git merge -q --ff-only "$stray"; fi
  fi
  main_now=$(git rev-parse "$MAIN")
  if [ "$main_now" != "$main_before" ]; then
    log "! session committed to $MAIN; moving those commits to $branch"
    if ! git cherry-pick "$main_before..$main_now" > /dev/null 2>&1; then
      git cherry-pick --abort > /dev/null 2>&1 || true
      log "! could not move them cleanly; they stay reachable as $main_now"
    fi
    git update-ref "refs/heads/$MAIN" "$main_before" "$main_now"
  fi
}

protect_runner_files() {
  local base
  base=$(git merge-base "$MAIN" HEAD)
  if ! git diff --quiet "$base" HEAD -- tasks.yaml implement.sh; then
    log "! session changed tasks.yaml or implement.sh; restoring them"
    git checkout "$base" -- tasks.yaml implement.sh 2> /dev/null || true
    git commit -q --no-verify -m "Restore runner files" || true
  fi
}

after_session() {
  restore_branch "$1" "$2"
  commit_wip "$1" "session end"
  protect_runner_files
}

# run_gate <task> <label>: gate + acceptance with CI=1, output in a log; tail printed on failure.
run_gate() {
  local id=$1 label=$2 dir="$STATE/logs/$1/$RUN_STAMP" rc=0
  local logfile="$dir/$label.log"
  log "⚙ $id · checking ($label)"
  supervise /dev/null "$logfile" "$logfile.stderr" "$GATE_TIMEOUT" "$GATE_TIMEOUT" "" \
    "${CLEAN[@]}" CI=1 FORCE_COLOR=0 bash -c '
      set -o pipefail
      echo "── gate: $1"
      bash -c "$1" 2>&1 || exit $?
      echo "── acceptance: $2"
      bash -c "$2" 2>&1' _ "$(gate_command)" "$(tf "$id" acceptance)" || rc=$?
  cat "$logfile.stderr" >> "$logfile" 2> /dev/null || true
  if [ -n "$SUPERVISE_TIMEOUT" ]; then
    printf '\n── timed out after %s seconds\n' "$GATE_TIMEOUT" >> "$logfile"
    rc=124
  fi
  if [ "$rc" -eq 0 ]; then
    log "✓ $id · checks passed"
    return 0
  fi
  LAST_GATE_LOG=$logfile
  log "✗ $id · checks failed (exit $rc). Log: $logfile"
  tail -n 25 "$logfile" | sed 's/^/    │ /'
  return 1
}

prompt_context() {
  local id=$1 resumed=$2
  printf '# Task %s: %s\n\n' "$id" "$(tf "$id" title)"
  cat <<'EOF'
You are building Mastermind, unattended, as one step of ./implement.sh. Nobody will answer questions, so make
sound decisions yourself, consistent with docs/PLAN.md, and record notable decisions or deviations in
docs/implementation-notes.md under a heading for this task.

EOF
  printf -- '- Milestone: %s\n' "$(tf "$id" milestone)"
  printf -- '- Depends on (already done): %s\n' "$(tf "$id" deps)"
  printf -- '- Primary areas: %s\n' "$(tf "$id" touches)"
  printf -- '- Tasks completed so far:%s\n' "$(done_list)"
  if [ "$resumed" = 1 ]; then
    printf -- '- A previous run of this task was interrupted. Its work is already committed on this branch\n'
    printf '  (see `git log %s..HEAD`). Continue from it rather than starting over.\n' "$MAIN"
  fi
  printf '\n## Goal\n\n%s\n\n## Tests\n\n%s\n\n' "$(tf "$id" goal)" "$(tf "$id" tests)"
  printf '## Acceptance\n\nThe task is done only when both commands exit 0 from the repo root (implement.sh runs them with CI=1):\n\n'
  printf '1. Gate: `%s`\n2. Acceptance: `%s`\n\n' "$(gate_command)" "$(tf "$id" acceptance)"
  printf '## Rules\n\n'
  cat <<'EOF'
- First read CLAUDE.md, the parts of docs/PLAN.md this task references, docs/implementation-notes.md and, if it
  exists, docs/claude-cli-notes.md. Study the existing code so your work fits it.
- Follow the code and testing standards in CLAUDE.md strictly: no `any`, strict types, no unnecessary comments,
  clean readable modules, and fewer but meaningful, robust tests.
EOF
  printf -- '- Stay on branch impl/%s. Never switch branches, rebase, reset, merge, stash, push or touch other branches;\n' "$id"
  printf '  implement.sh squashes your commits and rebases them onto %s.\n' "$MAIN"
  cat <<'EOF'
- Commit as you go, with plain commit messages and no trailers of any kind.
- Never edit tasks.yaml, implement.sh or anything under .implement/ other than your result file.
- Tests never call the real `claude`. Never run `claude auth login`, `claude auth logout` or `claude setup-token`.
- Never leave background processes running (dev servers, watchers) when you finish.
- Keep to this task's scope, but fix any defect in earlier work that blocks it.
- Before you finish, run both acceptance commands yourself and make them pass.
EOF
  printf -- '- Finish by writing .implement/results/%s.md: 3 to 10 plain lines on what you built and any notable\n' "$id"
  printf '  decisions. It becomes the body of the squashed commit, so it must not contain attribution lines.\n\n'
}

write_prompt() {
  local kind=$1 id=$2 file=$3 resumed=${4:-0} detail=${5:-} round=${6:-}
  {
    prompt_context "$id" "$resumed"
    case "$kind" in
      implement)
        printf '## Your job\n\nImplement this task completely, with its tests.\n'
        ;;
      fix)
        printf '## Your job: make the acceptance commands pass\n\n'
        printf 'The commands failed after the previous session (fix round %s of %s). The end of the output:\n\n' "$round" "$MAX_FIXES"
        printf '```\n%s\n```\n\nFull log: %s\n\n' "$(tail -n 120 "$detail")" "$detail"
        cat <<'EOF'
Find the root cause and fix it properly. Never weaken, skip or delete tests, loosen lint or type rules, or change
the gate to get to green. Then run both commands and make sure they pass.
EOF
        ;;
      review)
        printf '## Your job: review and improve\n\n'
        printf 'Another session implemented this task. Its work is `git diff %s...HEAD`. Review it in a fresh\n' "$MAIN"
        cat <<'EOF'
context, as a demanding senior engineer:

1. Completeness: every point of the Goal and Tests sections is implemented, faithful to docs/PLAN.md and the
   owner decisions in its section 22.
2. Correctness: bugs, races, process and resource leaks, unhandled errors, and security (path safety, token
   checks, environment cleaning, attribution).
3. Tests: meaningful and robust, covering important behaviour and failure paths. Merge or delete trivial tests.
   No flaky timing or fixed sleeps.
4. Types: no `any`, no unjustified `as` casts or `!` assertions, and external data validated with zod.
5. Readability: clean structure, good names, no unnecessary comments, no dead code.

Fix every issue you find directly in the code; don't just list it. Make sure both acceptance commands pass and
commit. Then append a short "Review" section to the result file listing what you changed, or "No changes".
EOF
        ;;
      rebase)
        printf '## Your job: bring this branch onto %s\n\n' "$MAIN"
        printf 'Branch impl/%s holds one squashed commit for this task, but rebasing it onto %s failed\n' "$id" "$MAIN"
        printf '(a conflict, or the checks failed afterwards). As an exception to the rules above, rebase it yourself:\n'
        printf 'run `git rebase %s`, resolve conflicts keeping the intent of both sides, and continue the rebase.\n' "$MAIN"
        printf 'Then make both acceptance commands pass and commit any fixes on impl/%s.\n' "$id"
        ;;
      rescue)
        printf '## Your job: rescue this task\n\n'
        printf 'Earlier sessions could not finish this task: %s.\n' "$FAILURE_NOTE"
        printf 'This is rescue attempt %s of %s. If it fails, the whole unattended build stops and waits for the\n' "$round" "$MAX_RESCUES"
        printf 'owner, so take the time to get it right.\n\n'
        if [ -n "$detail" ] && [ -f "$detail" ]; then
          printf 'The end of the latest failing check output:\n\n```\n%s\n```\n\nFull log: %s\n' "$(tail -n 150 "$detail")" "$detail"
        fi
        printf 'Every log of this task (sessions as stream-json, checks as text) is in %s.\n\n' "$STATE/logs/$id"
        cat <<'EOF'
Step back and work from first principles:

1. Reproduce the failure yourself and read the full logs, not just the tail.
2. Question the approach. The design may be wrong, a test may be flaky or depend on the environment, or the
   defect may sit in code from an earlier task. Fix the real cause wherever it lives, including earlier code,
   test helpers and build configuration.
3. If the environment is the cause (a missing browser download, a busy port, a native module that didn't build),
   fix it in the repo's own scripts so it also works unattended on a clean machine.
4. If the acceptance command expects something specific (a test file name, a heading), satisfy it.

Never weaken, skip or delete tests, loosen lint or type rules, change the gate, or edit tasks.yaml. Make both
acceptance commands pass and commit.
EOF
        ;;
    esac
  } > "$file"
}

verify_loop() {
  local id=$1 phase=$2 dir="$STATE/logs/$1/$RUN_STAMP" main_tip=$3 round=0 resume first_sid=$SESSION_ID
  while :; do
    if run_gate "$id" "$phase-check-$round"; then return 0; fi
    round=$((round + 1))
    if [ "$round" -gt "$MAX_FIXES" ]; then
      FAILURE_NOTE="the checks still failed after $MAX_FIXES fix rounds"
      log "✗ $id: $FAILURE_NOTE"
      return 1
    fi
    write_prompt fix "$id" "$dir/$phase-fix-$round.prompt.md" 0 "$dir/$phase-check-$((round - 1)).log" "$round"
    resume=""
    if [ "$round" -le 2 ]; then resume=$first_sid; fi
    run_session "$id" "$phase-fix-$round" "$dir/$phase-fix-$round.prompt.md" "$MODEL" "$resume" || true
    after_session "$id" "$main_tip"
  done
}

commit_message() {
  local id=$1 result="$STATE/results/$1.md"
  printf '%s\n\n' "$(tf "$id" title)"
  if [ -s "$result" ]; then
    grep -Eiv "$ATTRIBUTION_RE" "$result" | sed -e 's/[[:space:]]*$//' | awk 'NF { blank = 0 } !NF { blank++ } blank < 2' | head -n 80 || true
    printf '\n'
  fi
  printf 'Task: %s\n' "$id"
}

land_task() {
  local id=$1 branch="impl/$1" dir="$STATE/logs/$1/$RUN_STAMP" base try main_tip
  for try in 1 2 3; do
    commit_wip "$id" "before squash"
    base=$(git merge-base "$MAIN" HEAD)
    if [ "$(git rev-list --count "$base..HEAD")" -eq 0 ]; then
      FAILURE_NOTE="the branch has no changes compared to $MAIN, so nothing was built"
      log "✗ $id: $FAILURE_NOTE"
      return 1
    fi
    commit_message "$id" > "$dir/commit-message.txt"
    git reset -q --soft "$base" || return 1
    git commit -q --no-verify -F "$dir/commit-message.txt" || return 1
    main_tip=$(git rev-parse "$MAIN")
    if [ "$base" = "$main_tip" ]; then
      if [ "$try" -gt 1 ] && ! run_gate "$id" "after-rebase-$try"; then
        FAILURE_NOTE="the checks failed after rebasing onto $MAIN"
        return 1
      fi
      break
    fi
    log "$MAIN moved; rebasing $id onto it"
    if git rebase -q "$MAIN" > /dev/null 2>&1 && run_gate "$id" "after-rebase-$try"; then break; fi
    git rebase --abort > /dev/null 2>&1 || true
    if [ "$try" -eq 3 ]; then
      FAILURE_NOTE="it could not be rebased onto $MAIN cleanly"
      return 1
    fi
    write_prompt rebase "$id" "$dir/rebase-$try.prompt.md"
    if ! run_session "$id" "rebase-$try" "$dir/rebase-$try.prompt.md" "$MODEL"; then
      FAILURE_NOTE="the session rebasing it onto $MAIN kept failing"
      return 1
    fi
    restore_branch "$id" "$main_tip"
  done
  if git log "$MAIN..HEAD" --format=%B | grep -Eiq "$ATTRIBUTION_RE"; then
    FAILURE_NOTE="its commit message still contains AI attribution"
    log "✗ $id: $FAILURE_NOTE"
    return 1
  fi
  git switch -q "$MAIN" || return 1
  git merge -q --ff-only "$branch" || return 1
  git branch -q -D "$branch"
  log "✓ $id is on $MAIN as $(git log -1 --format='%h %s')"
}

finish_task() {
  local id=$1 phase=$2 main_tip=$3 dir="$STATE/logs/$1/$RUN_STAMP"
  verify_loop "$id" "$phase" "$main_tip" || return 1
  if [ "$REVIEW" = 1 ]; then
    write_prompt review "$id" "$dir/$phase-review.prompt.md"
    run_session "$id" "$phase-review" "$dir/$phase-review.prompt.md" "$REVIEW_MODEL" || true
    after_session "$id" "$main_tip"
    verify_loop "$id" "$phase-review" "$main_tip" || return 1
  fi
  land_task "$id"
}

run_task() {
  local id=$1 branch="impl/$1" dir="$STATE/logs/$1/$RUN_STAMP" resumed=0 main_tip rescue
  mkdir -p "$dir"
  log "━━━ $id: $(tf "$id" title)"
  git switch -q "$MAIN" || return 1
  if git show-ref -q --verify "refs/heads/$branch"; then
    git switch -q "$branch" || return 1
    if [ "$(git rev-list --count "$MAIN..HEAD")" -gt 0 ]; then resumed=1; fi
  else
    git switch -q -c "$branch" "$MAIN" || return 1
  fi
  main_tip=$(git rev-parse "$MAIN")
  FAILURE_NOTE=""
  LAST_GATE_LOG=""

  write_prompt implement "$id" "$dir/implement.prompt.md" "$resumed"
  run_session "$id" implement "$dir/implement.prompt.md" "$MODEL" || true
  after_session "$id" "$main_tip"
  if finish_task "$id" implement "$main_tip"; then return 0; fi

  for rescue in $(seq 1 "$MAX_RESCUES"); do
    if [ "$(git symbolic-ref -q --short HEAD)" != "$branch" ]; then git switch -q "$branch" || return 1; fi
    main_tip=$(git rev-parse "$MAIN")
    log "↻ $id · rescue $rescue of $MAX_RESCUES ($FAILURE_NOTE)"
    write_prompt rescue "$id" "$dir/rescue-$rescue.prompt.md" 0 "$LAST_GATE_LOG" "$rescue"
    run_session "$id" "rescue-$rescue" "$dir/rescue-$rescue.prompt.md" "$MODEL" || true
    after_session "$id" "$main_tip"
    if finish_task "$id" "rescue-$rescue" "$main_tip"; then return 0; fi
  done
  return 1
}

load_tasks() {
  [ -f "$TASKS_FILE" ] || die "missing $TASKS_FILE"
  if [ ! -d "$STATE/tools/node_modules/yaml" ]; then
    npm install --prefix "$STATE/tools" --no-audit --no-fund --silent yaml@2 > /dev/null || die "could not install the yaml parser"
  fi
  printf '%s\n' "$TASKS_MJS" > "$STATE/tools/tasks.mjs"
  node "$STATE/tools/tasks.mjs" "$TASKS_FILE" "$TASKS_JSON" || exit 1
}

list_tasks() {
  local id state
  for id in $(task_ids); do
    if is_done "$id"; then
      state="done"
    elif git show-ref -q --verify "refs/heads/impl/$id"; then
      state="in progress"
    elif [ -n "$(unmet_deps "$id")" ]; then
      state="waiting"
    else
      state="ready"
    fi
    printf '  %-12s %-24s %s\n' "[$state]" "$id" "$(tf "$id" title)"
  done
}

preflight() {
  local tool current
  for tool in jq perl "$CLAUDE_BIN"; do
    command -v "$tool" > /dev/null 2>&1 || die "$tool is required but not on PATH"
  done
  if ! command -v pnpm > /dev/null 2>&1; then
    log "Installing pnpm (npm i -g pnpm)…"
    npm install -g pnpm > /dev/null || die "could not install pnpm; install it and re-run"
  fi
  git rev-parse -q --verify "refs/heads/$MAIN" > /dev/null || die "branch $MAIN does not exist"
  git config user.name > /dev/null && git config user.email > /dev/null || die "set git user.name and user.email first"
  auth_ok || die "Claude Code is not signed in with a claude.ai subscription. Run 'claude', sign in with /login, then re-run."

  current=$(git symbolic-ref -q --short HEAD || echo "")
  case "$current" in
    "$MAIN")
      [ -z "$(git status --porcelain)" ] ||
        die "the working tree has uncommitted changes. Commit them first, e.g. git add -A && git commit -m 'Add implementation plan'"
      ;;
    impl/*)
      commit_wip "${current#impl/}" "interrupted"
      git switch -q "$MAIN"
      ;;
    *) die "switch to $MAIN first (currently on '${current:-a detached HEAD}')" ;;
  esac

  if command -v caffeinate > /dev/null 2>&1; then caffeinate -dimsu -w $$ > /dev/null 2>&1 & fi
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --list) LIST_ONLY=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --no-review) REVIEW=0 ;;
      --only)
        ONLY=${2:?--only needs a task id}
        shift
        ;;
      --until)
        UNTIL=${2:?--until needs a task id}
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
}

main() {
  parse_args "$@"
  command -v git > /dev/null 2>&1 || {
    echo "git is required" >&2
    exit 1
  }
  command -v node > /dev/null 2>&1 || {
    echo "node is required" >&2
    exit 1
  }
  ROOT=$(git rev-parse --show-toplevel 2> /dev/null) || {
    echo "run this inside the mastermind repository" >&2
    exit 1
  }
  cd "$ROOT"
  STATE="$ROOT/.implement"
  TASKS_FILE=${TASKS_FILE:-$ROOT/tasks.yaml}
  TASKS_JSON="$STATE/tasks.json"
  mkdir -p "$STATE/logs" "$STATE/results" "$STATE/tools" "$STATE/prompts"
  local exclude
  exclude=$(git rev-parse --git-path info/exclude)
  mkdir -p "$(dirname "$exclude")"
  grep -qxF '/.implement/' "$exclude" 2> /dev/null || printf '/.implement/\n' >> "$exclude"

  build_clean_env
  load_tasks
  if [ -n "$ONLY" ] && [ "$(jq --arg id "$ONLY" '[.tasks[] | select(.id == $id)] | length' "$TASKS_JSON")" = 0 ]; then
    die "unknown task $ONLY"
  fi

  if [ "$LIST_ONLY" = 1 ]; then
    list_tasks
    exit 0
  fi

  if [ "$DRY_RUN" = 1 ]; then
    local id
    for id in $(task_ids); do
      is_done "$id" && continue
      write_prompt implement "$id" "$STATE/prompts/$id.md"
      printf '  %-24s %s\n' "$id" "$STATE/prompts/$id.md"
    done
    exit 0
  fi

  preflight
  trap on_signal INT TERM HUP
  log "implement.sh: $(task_ids | wc -l | tr -d ' ') tasks, model $MODEL, review $([ "$REVIEW" = 1 ] && echo on || echo off). Ctrl+C stops safely."

  local id missing landed=0
  for id in $(task_ids); do
    if [ -n "$ONLY" ] && [ "$id" != "$ONLY" ]; then continue; fi
    if is_done "$id"; then
      if [ -n "$ONLY" ]; then log "$id is already done"; fi
      continue
    fi
    missing=$(unmet_deps "$id")
    if [ -n "$missing" ]; then die "$id needs$missing to be done first"; fi
    if ! run_task "$id"; then
      commit_wip "$id" "blocked"
      git switch -q "$MAIN" || true
      log "✗ $id is blocked after $MAX_RESCUES rescue attempts: $FAILURE_NOTE"
      log "Stopping the run. Its work stays on impl/$id; logs are in $STATE/logs/$id/$RUN_STAMP."
      log "Re-run ./implement.sh to retry it from where it stopped."
      notify "implement.sh" "Stopped: $id is blocked"
      exit 1
    fi
    landed=$((landed + 1))
    if [ "$id" = "$UNTIL" ]; then break; fi
  done

  log "Finished: $landed task(s) landed this run."
  if [ -z "$ONLY" ] && [ -z "$UNTIL" ]; then
    notify "implement.sh" "All tasks are done"
  fi
}

main "$@"; exit $?
