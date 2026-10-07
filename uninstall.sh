#!/bin/sh
# Undoes install.sh: unlinks the global `mastermind` command and removes this clone's dependencies and build
# output. With --purge it also deletes the task clones mastermind keeps in ~/.mastermind.
set -eu

root=$(cd "$(dirname -- "$0")" && pwd -P)
data_dir="$HOME/.mastermind"
purge=0
assume_yes=0

usage() {
  cat <<EOF
Usage: ./uninstall.sh [--purge] [--yes]

Removes what ./install.sh set up:
  - the global \`mastermind\` link in pnpm's global bin directory
  - node_modules and build output inside $root

Options:
  --purge   also delete $data_dir (the task clones of every project)
  --yes     do not ask before deleting with --purge

Each project's own .mastermind/ folder (its database, chat and logs) is left in place;
delete it by hand in projects you no longer want mastermind's history for.
EOF
}

step() {
  printf '\n==> %s\n' "$*"
}

warn() {
  printf 'warning: %s\n' "$*" >&2
}

fail() {
  printf 'uninstall failed: %s\n' "$*" >&2
  exit 1
}

default_pnpm_home() {
  case "$(uname -s)" in
    Darwin) printf '%s/Library/pnpm' "$HOME" ;;
    *) printf '%s/pnpm' "${XDG_DATA_HOME:-$HOME/.local/share}" ;;
  esac
}

refuse_while_running() {
  if pgrep -f 'cli/dist/index\.js' > /dev/null 2>&1; then
    fail "mastermind is still running. Press Ctrl+C twice in its terminal, then run this again."
  fi
}

unlink_command() {
  step "Unlinking the mastermind command"
  if ! command -v pnpm > /dev/null; then
    warn "pnpm is not installed, so there is no pnpm global link to remove"
    return
  fi
  PNPM_HOME=${PNPM_HOME:-$(default_pnpm_home)}
  PATH="$PNPM_HOME/bin:$PNPM_HOME:$PATH"
  export PNPM_HOME PATH
  if (cd / && pnpm list --global --depth 0 2> /dev/null) | grep -q '@mastermind/cli'; then
    (cd / && pnpm remove --global @mastermind/cli)
  else
    printf 'Not linked.\n'
  fi
  hash -r 2> /dev/null || true
  if remaining=$(command -v mastermind); then
    warn "another \`mastermind\` is still on your PATH at $remaining; remove it by hand"
  fi
}

remove_build_output() {
  step "Removing dependencies and build output from $root"
  for path in \
    "$root/node_modules" \
    "$root"/packages/*/node_modules \
    "$root"/packages/*/dist \
    "$root/coverage" \
    "$root/test-results" \
    "$root/playwright-report" \
    "$root/blob-report"; do
    [ -e "$path" ] || continue
    rm -rf "$path"
    printf 'Removed %s\n' "${path#"$root"/}"
  done
}

confirm() {
  [ "$assume_yes" = 1 ] && return 0
  if [ ! -t 0 ]; then
    printf '%s Not deleting without a terminal to confirm; pass --yes.\n' "$1"
    return 1
  fi
  printf '%s [y/N] ' "$1"
  read -r answer
  case "$answer" in
    y | Y | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

purge_data() {
  step "Deleting $data_dir"
  if [ ! -e "$data_dir" ]; then
    printf 'Nothing to delete.\n'
    return
  fi
  size=$(du -sh "$data_dir" 2> /dev/null | awk '{ print $1 }')
  if confirm "Delete $data_dir (${size:-unknown size})? Task clones may hold work that was never rebased onto main."; then
    rm -rf "$data_dir"
    printf 'Deleted %s\n' "$data_dir"
  else
    printf 'Kept %s\n' "$data_dir"
  fi
}

for arg in "$@"; do
  case "$arg" in
    --purge) purge=1 ;;
    --yes | -y) assume_yes=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

refuse_while_running
unlink_command
remove_build_output
if [ "$purge" = 1 ]; then
  purge_data
fi

step "Uninstalled"
if [ "$purge" = 0 ] && [ -e "$data_dir" ]; then
  printf 'Task clones remain in %s; run ./uninstall.sh --purge to delete them.\n' "$data_dir"
fi
printf "Each project's .mastermind/ folder is left in place. ./install.sh reinstalls.\n"
