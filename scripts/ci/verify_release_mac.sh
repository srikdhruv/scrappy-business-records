#!/bin/bash
# After a release is published: install it on a fresh Mac the way the owner would, with main's
# install.sh from raw.githubusercontent.com and the release's own files.
#
#   scripts/ci/verify_release_mac.sh <tag> [latest|tagged]
#
# latest (default): the literal install line from docs/runbooks/install-mac.md, which must
#   install <tag>; then the --version form too.
# tagged: only the `--version <tag>` form, for a release that is still a prerelease.
# Either way: the app opens, data survives a restart, re-running the line (the update) keeps
# the data and takes a backup. Installs into the real ~/Library/Application Support of the
# (throwaway) CI machine. The macOS counterpart of verify_release_windows.ps1.
set -euo pipefail

TAG=$1
MODE=${2:-latest}
HERE=$(cd "$(dirname "$0")" && pwd)
URL=https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.sh
ROOT="$HOME/Library/Application Support/ScrappyRecords"
DB="$ROOT/data/records.db"
BACKUPS="$HOME/Documents/ScrappyRecords Backups"
NAME="Ananya Rao (release check)"
EXPECTED=${TAG#v}
export SCRAPPY_NO_BROWSER=1 SCRAPPY_NO_DIALOG=1

step() { printf '\n=== %s\n' "$*"; }
fail() {
    echo "RELEASE CHECK FAILED: $*" >&2
    tail -n 40 "$ROOT/logs/server.log" 2>/dev/null || true
    exit 1
}
version() {
    /usr/bin/curl -fsS --max-time 3 http://127.0.0.1:8765/api/health 2>/dev/null |
        sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}
wait_health() {
    for _ in $(seq 1 180); do
        [ -z "$(version)" ] || return 0
        sleep 0.5
    done
    fail "the app did not answer on http://127.0.0.1:8765"
}
probe() { "$ROOT/app/python/bin/python3" "$HERE/db_probe.py" "$@"; }
stop_app() {
    pkill -f "$ROOT/app/python/bin/python3" || true
    for _ in $(seq 1 60); do
        [ -n "$(version)" ] || return 0
        sleep 0.5
    done
}
install_line() {
    if [ "$1" = latest ]; then
        /usr/bin/curl -fsSL "$URL" | sh
    else
        /usr/bin/curl -fsSL "$URL" | sh -s -- --version "$TAG"
    fi
}

step "Install ($MODE), expecting version $EXPECTED"
install_line "$MODE" || fail "the install line failed"
wait_health
[ "$(version)" = "$EXPECTED" ] || fail "installed version $(version), expected $EXPECTED"
[ -d "$HOME/Applications/Scrappy Records.app" ] || [ -x "$HOME/Applications/Scrappy Records.command" ] ||
    fail "no Scrappy Records in ~/Applications"

step "Add a student, restart, still there"
probe insert "$DB" "$NAME"
stop_app
(cd "$ROOT/app" && ./python/bin/python3 -m app.launcher) || fail "the launcher failed after a restart"
probe check "$DB" "$NAME" || fail "the student did not survive a restart"

step "Run the same line again (the update): data kept, backup taken"
install_line "$MODE" || fail "the update failed"
wait_health
probe check "$DB" "$NAME" || fail "the student did not survive the update"
ls "$BACKUPS"/records-pre-update-*.db >/dev/null 2>&1 || fail "no pre-update backup in $BACKUPS"

if [ "$MODE" = latest ]; then
    step "The --version $TAG form"
    install_line tagged || fail "--version failed"
    wait_health
    [ "$(version)" = "$EXPECTED" ] || fail "--version installed $(version)"
    probe check "$DB" "$NAME" || fail "the student did not survive --version"
fi

stop_app
printf '\nRELEASE CHECK PASSED\n'
