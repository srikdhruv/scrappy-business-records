#!/bin/bash
# End-to-end check of the macOS install, as a user with no developer tools would get it.
#
#   scripts/ci/smoke_install_mac.sh dist/scrappy-records-macos-arm64.zip
#
# Everything runs under `env -i PATH=/usr/bin:/bin` (no uv, no virtualenv, no Homebrew) in a
# temporary folder, on a spare port, so it never touches a real install:
#   install -> no data folder yet -> launch -> health -> add a student -> stop -> relaunch ->
#   still there + daily backup -> reinstall (update) with the app running -> pre-update backup ->
#   still there.
set -euo pipefail

ZIP=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
HERE=$(cd "$(dirname "$0")" && pwd)
PORT=${SCRAPPY_SMOKE_PORT:-18765}
WORK=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/scrappy-smoke.XXXXXX")" && pwd)
ROOT="$WORK/ScrappyRecords"
BACKUPS="$WORK/backups"
APPS="$WORK/Applications"
NAME="Kabir Mehta (smoke test)"

bare() {
    # A clean environment: only the system's own tools on PATH.
    env -i HOME="$HOME" USER="${USER:-}" TMPDIR="${TMPDIR:-/tmp}" PATH=/usr/bin:/bin \
        SCRAPPY_HOME="$ROOT" SCRAPPY_BACKUP_DIR="$BACKUPS" SCRAPPY_PORT="$PORT" \
        SCRAPPY_NO_BROWSER=1 SCRAPPY_NO_DIALOG=1 "$@"
}
py() { bare "$ROOT/app/python/bin/python3" "$@"; }
health() { /usr/bin/curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health"; }
stop_server() {
    pkill -f "$ROOT/app/python/bin/python3 -m app" || true
    for _ in $(seq 1 40); do health >/dev/null 2>&1 || return 0; sleep 0.25; done
    echo "server didn't stop" >&2
    return 1
}
cleanup() { stop_server || true; rm -rf "$WORK"; }
trap cleanup EXIT
step() { printf '\n=== %s\n' "$*"; }

step "No developer tools on the clean PATH"
if bare /bin/sh -c 'command -v uv || [ -n "${VIRTUAL_ENV:-}" ]'; then
    echo "developer tools are visible" >&2
    exit 1
fi

step "Install from the zip"
bare /bin/sh "$HERE/../install.sh" --zip "$ZIP" --no-launch --install-root "$ROOT" --apps-dir "$APPS" |
    tee "$WORK/install1.log"
grep -q "Scrappy Records is installed" "$WORK/install1.log"
test -d "$APPS/Scrappy Records.app" || test -x "$APPS/Scrappy Records.command"
test ! -e "$ROOT/data" || { echo "install created the data folder" >&2; exit 1; }

step "Launch (from another folder), check health"
(cd / && py -m app.launcher)
health | grep -q '"app":"scrappy-records"'
test -f "$ROOT/data/records.db"

step "Add a student, restart, check it survived"
py "$HERE/db_probe.py" insert "$ROOT/data/records.db" "$NAME"
stop_server
(cd / && py -m app.launcher)
health >/dev/null
py "$HERE/db_probe.py" check "$ROOT/data/records.db" "$NAME"
DAILY="$BACKUPS/records-$(date +%Y-%m-%d).db"
test -f "$DAILY" || { echo "no daily backup at $DAILY" >&2; exit 1; }
py "$HERE/db_probe.py" check "$DAILY" "$NAME"

step "Reinstall (the update path) while the app is running"
bare /bin/sh "$HERE/../install.sh" --zip "$ZIP" --no-launch --install-root "$ROOT" --apps-dir "$APPS" |
    tee "$WORK/install2.log"
grep -q "Scrappy Records is installed" "$WORK/install2.log"
! health >/dev/null 2>&1 || { echo "the installer didn't stop the running app" >&2; exit 1; }
ls "$BACKUPS"/records-pre-update-*.db
py "$HERE/db_probe.py" check "$BACKUPS"/records-pre-update-*.db "$NAME"
test ! -e "$ROOT/app.old" && test ! -e "$ROOT/app.new"

step "Launch the updated app, data still there"
(cd / && py -m app.launcher)
health >/dev/null
py "$HERE/db_probe.py" check "$ROOT/data/records.db" "$NAME"

step "Port taken by another program: the launcher fails politely and logs why"
stop_server
/usr/bin/python3 -c "
import socket, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('127.0.0.1', $PORT)); s.listen(); time.sleep(30)" &
BLOCKER=$!
sleep 1
if (cd / && py -m app.launcher); then
    kill $BLOCKER
    echo "the launcher should have failed" >&2
    exit 1
fi
kill $BLOCKER
grep -q "Something else is using port $PORT" "$ROOT/logs/server.log"

printf '\nSMOKE TEST PASSED\n'
