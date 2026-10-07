#!/bin/sh
# Installs mastermind from this clone: checks prerequisites, installs dependencies, builds, and links the
# `mastermind` command into pnpm's global bin directory. Run it again after pulling to update.
set -eu

root=$(cd "$(dirname -- "$0")" && pwd -P)
min_node=22.13.0
min_claude=2.1.283
shell_changed=0

usage() {
  cat <<EOF
Usage: ./install.sh

Installs mastermind from $root and puts \`mastermind\` on your PATH.

  1. Checks for git, Node.js $min_node or later, pnpm and Claude Code.
  2. Runs \`pnpm install --frozen-lockfile\` and \`pnpm build\`.
  3. Links packages/cli into pnpm's global bin directory, first adding that directory to your
     shell profile if it is not on your PATH yet.

Run it again after pulling new changes. ./uninstall.sh undoes it.
EOF
}

step() {
  printf '\n==> %s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

fail() {
  printf 'install failed: %s\n' "$*" >&2
  exit 1
}

version_at_least() {
  node -e '
    const parse = (v) => v.replace(/^v/, "").split(/[.-]/).slice(0, 3).map(Number);
    const [have, want] = [parse(process.argv[1]), parse(process.argv[2])];
    const diff = have.map((n, i) => n - want[i]).find((d) => d !== 0) ?? 0;
    process.exit(diff >= 0 ? 0 : 1);
  ' "$1" "$2"
}

default_pnpm_home() {
  case "$(uname -s)" in
    Darwin) printf '%s/Library/pnpm' "$HOME" ;;
    *) printf '%s/pnpm' "${XDG_DATA_HOME:-$HOME/.local/share}" ;;
  esac
}

check_prerequisites() {
  step "Checking prerequisites"
  case "$(uname -s)" in
    Darwin | Linux) ;;
    *) fail "mastermind runs on macOS and Linux (including WSL) only" ;;
  esac

  command -v git > /dev/null || fail "git is not installed"

  command -v node > /dev/null || fail "Node.js $min_node or later is required (https://nodejs.org)"
  node_version=$(node --version)
  version_at_least "$node_version" "$min_node" || fail "Node.js $min_node or later is required; found $node_version"

  if ! command -v pnpm > /dev/null; then
    command -v npm > /dev/null || fail "pnpm is not installed and npm is not available to install it"
    pnpm_major=$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).packageManager.split("@")[1].split(".")[0]' "$root/package.json")
    step "Installing pnpm $pnpm_major with npm"
    npm install --global "pnpm@$pnpm_major"
  fi

  if command -v claude > /dev/null; then
    claude_version=$(claude --version 2> /dev/null | awk '{ print $1 }')
    version_at_least "${claude_version:-0.0.0}" "$min_claude" ||
      warn "Claude Code $min_claude or later is required; found ${claude_version:-an unknown version}. Update it with \`claude update\`."
  else
    warn "Claude Code is not on your PATH. Install it before running mastermind: https://docs.claude.com/en/docs/claude-code"
  fi

  if [ "$(uname -s)" = Linux ]; then
    for tool in bwrap socat; do
      command -v "$tool" > /dev/null ||
        warn "$tool is missing; Claude Code's sandbox on Linux needs bubblewrap and socat"
    done
  fi

  printf 'git %s, Node.js %s, pnpm %s\n' \
    "$(git --version | awk '{ print $3 }')" "$node_version" "$(pnpm --version)"
}

build() {
  step "Installing dependencies"
  (cd "$root" && pnpm install --frozen-lockfile)

  step "Building"
  (cd "$root" && pnpm build)
  for asset in index.js web/index.html prompts/conductor.md; do
    [ -f "$root/packages/cli/dist/$asset" ] || fail "the build did not produce packages/cli/dist/$asset"
  done
}

shell_profile() {
  case "$(basename -- "${SHELL:-sh}")" in
    zsh) printf '%s/.zshrc' "${ZDOTDIR:-$HOME}" ;;
    bash) printf '%s/.bashrc' "$HOME" ;;
    *) printf '%s/.profile' "$HOME" ;;
  esac
}

ensure_global_bin_dir() {
  if (cd / && pnpm bin --global > /dev/null 2>&1); then
    return
  fi
  PNPM_HOME=${PNPM_HOME:-$(default_pnpm_home)}
  PATH="$PNPM_HOME/bin:$PATH"
  export PNPM_HOME PATH
  profile=$(shell_profile)
  # This writes the block `pnpm setup` would write, without `pnpm setup` itself: that also reinstalls pnpm
  # into its own global directory, which breaks pnpm when it was installed by Homebrew.
  if ! grep -qs '^# pnpm$' "$profile"; then
    step "Adding pnpm's global bin directory to $profile"
    cat >> "$profile" <<EOF

# pnpm
export PNPM_HOME='$PNPM_HOME'
case ":\$PATH:" in
  *":\$PNPM_HOME/bin:"*) ;;
  *) export PATH="\$PNPM_HOME/bin:\$PATH" ;;
esac
# pnpm end
EOF
    shell_changed=1
  fi
  (cd / && pnpm bin --global > /dev/null 2>&1) ||
    fail "pnpm's global bin directory $PNPM_HOME/bin is not usable; add it to your PATH and try again"
}

link() {
  ensure_global_bin_dir
  step "Linking the mastermind command"
  (cd / && pnpm add --global "link:$root/packages/cli")

  bin_dir=$(cd / && pnpm bin --global)
  installed=$(command -v mastermind) || fail "mastermind is not on PATH after linking"
  case "$installed" in
    "$bin_dir"/*) ;;
    *) warn "\`mastermind\` resolves to $installed, which shadows the one just linked into $bin_dir" ;;
  esac
}

case "${1-}" in
  "") ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

check_prerequisites
build
link

step "Installed mastermind $(mastermind --version)"
if [ "$shell_changed" = 1 ]; then
  printf 'Added pnpm'\''s global bin directory to %s. Open a new terminal before running mastermind.\n' "$(shell_profile)"
fi
cat <<'EOF'
Next:
  mastermind doctor <project>   check the machine and a project are ready
  cd <project> && mastermind .  start it in a git repository
EOF
