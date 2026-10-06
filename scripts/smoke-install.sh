#!/bin/sh
# Installs mastermind from a fresh clone of this repo's HEAD into a throwaway global prefix, then runs the
# installed binary against fake-claude. Uncommitted changes are not part of the clone.
set -eu

repo=$(git -C "$(dirname -- "$0")/.." rev-parse --show-toplevel)
work=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/mastermind-smoke.XXXXXX")" && pwd -P)
trap 'rm -rf "$work"' EXIT
trap 'exit 130' INT TERM

clone="$work/mastermind"
home="$work/home"
bin="$work/bin"
project="$work/project"
pnpm_home="$work/pnpm-home"

step() {
  printf '\n==> %s\n' "$*"
}

fail() {
  printf 'smoke:install failed: %s\n' "$*" >&2
  exit 1
}

if [ -n "$(git -C "$repo" status --porcelain)" ]; then
  printf 'Note: %s has uncommitted changes; the smoke test uses the last commit.\n' "$repo" >&2
fi

step "Cloning $(git -C "$repo" rev-parse --short HEAD) into $clone"
git clone --quiet "$repo" "$clone"

step "Installing and building"
(cd "$clone" && pnpm install --frozen-lockfile && pnpm build)
for asset in web/index.html prompts/conductor.md prompts/worker.md; do
  [ -f "$clone/packages/cli/dist/$asset" ] || fail "the CLI build is missing dist/$asset"
done

step "Linking into a temporary global prefix"
# pnpm 10 puts global bins in PNPM_HOME and pnpm 11 and later in PNPM_HOME/bin.
PATH="$pnpm_home/bin:$pnpm_home:$PATH"
export PATH
(cd "$work" && PNPM_HOME="$pnpm_home" pnpm add --global "link:$clone/packages/cli")
installed=$(command -v mastermind) || fail "mastermind is not on PATH after linking"
case "$installed" in
  "$pnpm_home"/*) ;;
  *) fail "mastermind resolves to $installed, not the temporary prefix" ;;
esac

step "Preparing fake-claude and a project"
mkdir -p "$bin" "$home/.claude"
ln -s "$clone/test/fixtures/fake-claude/bin/claude" "$bin/claude"
ln -s "$clone/test/fixtures/fake-claude/bin/run.js" "$bin/run.js"
printf '{"attribution":{"commit":"","pr":"","sessionUrl":false}}\n' >"$home/.claude/settings.json"
if [ "$(uname -s)" = Linux ]; then
  # Doctor requires bubblewrap and socat on Linux; stubs keep the result independent of the machine.
  for tool in bwrap socat; do
    printf '#!/bin/sh\nexit 0\n' >"$bin/$tool"
    chmod +x "$bin/$tool"
  done
fi
git init --quiet --initial-branch dev "$project"
git -C "$project" -c user.name=Smoke -c user.email=smoke@example.com \
  commit --quiet --allow-empty --message "Initial commit"

run_installed() {
  env -i \
    HOME="$home" \
    PATH="$bin:$PATH" \
    TMPDIR="${TMPDIR:-/tmp}" \
    LANG="${LANG:-C.UTF-8}" \
    CLAUDE_CONFIG_DIR="$home/.claude" \
    FAKE_CLAUDE_ACCOUNT=max \
    FAKE_CLAUDE_STATE="$work/fake-claude-state" \
    mastermind "$@"
}

step "mastermind --version"
expected=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' \
  "$clone/packages/cli/package.json")
version=$(run_installed --version)
printf '%s\n' "$version"
[ "$version" = "$expected" ] || fail "expected version $expected, got $version"

step "mastermind doctor"
run_installed doctor "$project" || fail "mastermind doctor exited with status $?"

step "smoke:install passed"
