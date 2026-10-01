#!/bin/sh
# Scrappy Records installer and updater for macOS on Apple Silicon.
#
# Install or update (paste into Terminal):
#   curl -fsSL https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.sh | sh
#
# With options:
#   curl -fsSL .../install.sh | sh -s -- --version v0.1.0
#
# Options (or the environment variable in brackets):
#   --zip FILE           Install from this zip instead of downloading it. The zip is kept.
#                        [SCRAPPY_INSTALL_ZIP]
#   --version TAG        Install this release (e.g. v0.1.0) instead of the latest.
#   --no-launch          Don't open the app at the end.            [SCRAPPY_NO_LAUNCH=1]
#   --install-root DIR   Testing only: install here instead of
#                        ~/Library/Application Support/ScrappyRecords. [SCRAPPY_INSTALL_ROOT]
#   --apps-dir DIR       Testing only: put "Scrappy Records.app" here instead of
#                        ~/Applications.                            [SCRAPPY_APPS_DIR]
#   [SCRAPPY_TEST_FAIL_AFTER_BACKUP=FILE]  Testing only: if FILE exists, delete it and fail just
#                        after the backup, so CI can check what a failed update does.
#
# Started by the app itself (Settings -> Update now, docs/adr/0006-in-app-update.md): the app
# downloads THIS file from the new release's tag and runs it in its own session as
#   /bin/sh install.sh --version <tag>
# with SCRAPPY_UPDATE_FROM_APP=1 and SCRAPPY_INSTALL_ROOT (the running copy's folder) set, and
# the output going to logs/update.log. Nothing may ask a question, and the app must end up open
# again: the new version if it worked, else the old one (if this closed it). Older apps start
# newer copies of this file this way: keep it working (docs/runbooks/release.md).
#
# Same steps as scripts/install.ps1: download, check against the release's SHA256SUMS and
# unpack to app.new, stop the running app, back up the data, swap app.new in for app (the data
# folder is never touched), create the launcher, delete the download, open the app and wait for
# the new version to answer (else put the old one back, kept as app.old until then).
#   [SCRAPPY_TEST_MODE=1 + SCRAPPY_INSTALL_DOWNLOAD_URL=URL/]  Testing only: download the
#                        release's files (zip, SHA256SUMS) from URL instead of GitHub.

set -eu

REPO="srikdhruv/scrappy-business-records"
ASSET="scrappy-records-macos-arm64.zip"
HELP_URL="https://github.com/$REPO/blob/main/docs/runbooks/troubleshooting.md"

say() { printf '  - %s\n' "$*"; }

fail() {
    printf '\n\033[31mSorry, Scrappy Records was NOT installed. Your data has not been changed.\033[0m\n' >&2
    # "Details:" as install.ps1 says it: the app shows this line as the technical reason.
    printf 'Details: %s\n' "$*" >&2
    printf 'Help: %s\n' "$HELP_URL" >&2
    exit 1
}

# PIDs of processes started from our own app folders (never anyone else's Python).
app_pids() {
    root_real=$(cd "$1" 2>/dev/null && pwd -P || printf '%s' "$1")
    # A UTF-8 locale, or ps escapes non-English letters in folder names and nothing matches.
    LC_ALL=en_US.UTF-8 ps -axo pid=,command= | while read -r pid cmd; do
        for prefix in "$1/app" "$root_real/app"; do
            case "$cmd" in
                "$prefix/python/"* | "$prefix.new/python/"* | "$prefix.old/python/"*)
                    echo "$pid"
                    ;;
            esac
        done
    done
}

# Ask politely (SIGTERM: the server finishes what it's doing and exits), then force after 10 s.
stop_running_app() {
    pids=$(app_pids "$1")
    [ -n "$pids" ] || return 0
    stopped_app=1
    kill $pids 2>/dev/null || true
    i=0
    while [ $i -lt 20 ] && [ -n "$(app_pids "$1")" ]; do
        sleep 0.5
        i=$((i + 1))
    done
    pids=$(app_pids "$1")
    [ -z "$pids" ] || kill -9 $pids 2>/dev/null || true
    say "Closed the running copy of Scrappy Records."
}

# Back up the database: the app's own backup (old version's Python, else the new one's), else a
# copy of the file together with any journal SQLite left (opening the copy finishes the
# interrupted save). Never pretends: if nothing works, stop before changing anything.
backup_data() {
    database="$1"
    shift
    for bundle in "$@"; do
        [ -x "$bundle/python/bin/python3" ] || continue
        if (cd "$bundle" && ./python/bin/python3 -m app.backup --reason pre-update); then
            return 0
        fi
        say "A backup attempt didn't work."
    done
    name="records-pre-update-$(date +%Y%m%d-%H%M%S).db"
    for dir in "${SCRAPPY_BACKUP_DIR:-$HOME/Documents/ScrappyRecords Backups}" "$(dirname "$database")/backups"; do
        if mkdir -p "$dir" 2>/dev/null; then
            ok=1
            for suffix in -journal -wal -shm; do
                if [ -f "$database$suffix" ]; then
                    cp "$database$suffix" "$dir/$name$suffix" 2>/dev/null || ok=0
                fi
            done
            if [ $ok = 1 ] && cp "$database" "$dir/$name" 2>/dev/null; then
                say "Backup saved (file copy): $dir/$name"
                return 0
            fi
        fi
    done
    fail "Couldn't save a backup copy of your data, so nothing was changed. Restart the Mac and try again."
}

# On any failure after the app was closed for an update started from the app, open the version
# that is installed now (the old one, or the new one if only a later step failed), so the owner
# isn't left without it.
on_exit() {
    status=$1
    [ -z "${tmp:-}" ] || rm -rf "$tmp"
    if [ "$status" != 0 ] && [ "$from_app" = 1 ] && [ "$stopped_app" = 1 ] && [ "$launched" = 0 ] &&
        [ -x "${app_dir:-}/python/bin/python3" ]; then
        printf 'Opening the version that is installed again...\n' >&2
        (cd "$app_dir" && SCRAPPY_AFTER_UPDATE=1 ./python/bin/python3 -m app.launcher) >/dev/null 2>&1 || true
    fi
}

# check_sum FILE NAME SUMS: FILE must have the SHA-256 that SUMS (sha256sum's format) gives for
# NAME, or nothing is changed.
check_sum() {
    expected=$(awk -v n="$2" '{ f = $2; sub(/^\*/, "", f); if (f == n && length($1) == 64) print tolower($1) }' "$3" | tail -n 1)
    [ -n "$expected" ] ||
        fail "The checksum list (SHA256SUMS) doesn't include $2, so the download can't be checked. Nothing was changed."
    actual=$(/usr/bin/shasum -a 256 "$1" | awk '{ print tolower($1) }')
    [ "$actual" = "$expected" ] ||
        fail "The download doesn't match its checksum (SHA256SUMS): it may be damaged, or not the real one. Nothing was changed."
    say "The download matches its checksum."
}

# The version /api/health answers with ("" if Scrappy Records isn't answering).
running_version() {
    /usr/bin/curl -fsS --max-time 3 "http://127.0.0.1:${SCRAPPY_PORT:-8765}/api/health" 2>/dev/null |
        sed -n 's/.*"app":"scrappy-records".*"version":"\([^"]*\)".*/\1/p'
}

# wait_for_version VERSION LAUNCHER_OK ROOT: up to 3 minutes for VERSION to answer. Gives up
# early if the launcher failed and none of the app's programs is running (it won't start).
wait_for_version() {
    i=0
    while [ $i -lt 360 ]; do
        [ "$(running_version)" != "$1" ] || return 0
        if [ "$2" != 1 ] && [ -z "$(app_pids "$3")" ]; then
            sleep 1
            [ "$(running_version)" = "$1" ]
            return
        fi
        sleep 0.5
        i=$((i + 1))
    done
    return 1
}

# One line in logs/update.log (an update started from the app writes all its output there).
log_line() {
    logs="${SCRAPPY_HOME:-$root}/logs"
    mkdir -p "$logs" 2>/dev/null && printf '%s %s\n' "$(date +%Y-%m-%dT%H:%M:%S)" "$*" >>"$logs/update.log" || true
}

applescript_string() {
    # Quote a value for an AppleScript string literal.
    printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

main() {
    from_app="${SCRAPPY_UPDATE_FROM_APP:-0}"
    stopped_app=0
    launched=0
    tmp=""
    trap 'on_exit $?' EXIT
    zip_path="${SCRAPPY_INSTALL_ZIP:-}"
    version=""
    no_launch="${SCRAPPY_NO_LAUNCH:-0}"
    root="${SCRAPPY_INSTALL_ROOT:-$HOME/Library/Application Support/ScrappyRecords}"
    apps_dir="${SCRAPPY_APPS_DIR:-$HOME/Applications}"
    while [ $# -gt 0 ]; do
        case "$1" in
            --zip) zip_path="$2"; shift 2 ;;
            --version) version="$2"; shift 2 ;;
            --no-launch) no_launch=1; shift ;;
            --install-root) root="$2"; shift 2 ;;
            --apps-dir) apps_dir="$2"; shift 2 ;;
            *) fail "Unknown option: $1" ;;
        esac
    done

    printf '\n\033[36mInstalling Scrappy Records\033[0m\n'
    [ "$from_app" != 1 ] || say "Started from the app, to install ${zip_path:-$version}."

    [ "$(uname -s)" = "Darwin" ] || fail "This installer is for macOS. On Windows, use install.ps1."
    [ "$(uname -m)" = "arm64" ] || fail "Scrappy Records needs a Mac with Apple Silicon (M1 or newer)."

    mkdir -p "$root" || fail "Couldn't create $root"
    root=$(cd "$root" && pwd)
    app_dir="$root/app"
    new_dir="$root/app.new"
    old_dir="$root/app.old"
    if [ -z "${SCRAPPY_HOME:-}" ] && [ "$root" != "$HOME/Library/Application Support/ScrappyRecords" ]; then
        # A test install elsewhere: point the backup and the app at it too.
        export SCRAPPY_HOME="$root"
    fi
    if [ -n "${SCRAPPY_DATA_DIR:-}" ]; then
        database="$SCRAPPY_DATA_DIR/records.db"
    else
        database="${SCRAPPY_HOME:-$root}/data/records.db"
    fi

    # 1. Get the zip, and check it against the release's SHA256SUMS.
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/scrappy-install.XXXXXX")
    if [ -n "$zip_path" ]; then
        [ -f "$zip_path" ] || fail "No such file: $zip_path"
        say "Using $zip_path"
        # A local zip (tests, or whoever set this up) is checked if a SHA256SUMS lies next to it.
        local_sums="$(dirname "$zip_path")/SHA256SUMS"
        [ ! -f "$local_sums" ] || check_sum "$zip_path" "$(basename "$zip_path")" "$local_sums"
    else
        if [ -n "$version" ]; then
            case "$version" in v*) ;; *) version="v$version" ;; esac
        fi
        if [ "${SCRAPPY_TEST_MODE:-}" = 1 ] && [ -n "${SCRAPPY_INSTALL_DOWNLOAD_URL:-}" ]; then
            base="${SCRAPPY_INSTALL_DOWNLOAD_URL%/}/"  # testing only: a local release server
        elif [ -n "$version" ]; then
            base="https://github.com/$REPO/releases/download/$version/"
        else
            base="https://github.com/$REPO/releases/latest/download/"
        fi
        zip_path="$tmp/$ASSET"
        say "Downloading Scrappy Records (about 30 MB, this can take a minute)..."
        if ! curl -fL --retry 3 --silent --show-error -o "$zip_path" "$base$ASSET"; then
            fail "The download failed or was not found. Check the internet connection and try again; if it keeps failing, the release may not be published yet."
        fi
        sums_status=$(curl -L --retry 3 --silent -o "$tmp/SHA256SUMS" -w '%{http_code}' "${base}SHA256SUMS") ||
            fail "Couldn't download the checksum list (SHA256SUMS). Check the internet connection and try again."
        if [ "$sums_status" = 200 ]; then
            check_sum "$zip_path" "$ASSET" "$tmp/SHA256SUMS"
        elif [ "$sums_status" = 404 ]; then
            # Only releases from before checksums (v0.1.0) have no SHA256SUMS.
            zip_version=$(/usr/bin/unzip -p "$zip_path" VERSION 2>/dev/null | head -n 1 | tr -d '\r ')
            case "$zip_version" in
                0.0.* | 0.1.0) say "Version $zip_version was published before checksums; installing it unchecked." ;;
                *) fail "This release has no checksum list (SHA256SUMS), so the download can't be checked. Nothing was changed." ;;
            esac
        else
            fail "Couldn't download the checksum list (SHA256SUMS). Check the internet connection and try again."
        fi
    fi

    # 2. Unpack next to the current copy.
    say "Unpacking..."
    rm -rf "$new_dir"
    /usr/bin/unzip -q "$zip_path" -d "$new_dir" || fail "The download looks damaged. Try again."
    for required in python/bin/python3 app/launcher.py VERSION; do
        [ -e "$new_dir/$required" ] || fail "The download looks incomplete ($required is missing)."
    done
    # Files from the internet can be flagged by macOS; this copy is ours, so clear the flag.
    xattr -dr com.apple.quarantine "$new_dir" 2>/dev/null || true

    # 3. Stop the running app, if any.
    stop_running_app "$root"

    # 4. Back up the data before changing anything.
    if [ -f "$database" ]; then
        say "Saving a backup copy of your data..."
        backup_data "$database" "$app_dir" "$new_dir"
    fi
    if [ -n "${SCRAPPY_TEST_FAIL_AFTER_BACKUP:-}" ] && [ -f "$SCRAPPY_TEST_FAIL_AFTER_BACKUP" ]; then
        rm -f "$SCRAPPY_TEST_FAIL_AFTER_BACKUP"
        fail "Test hook: failing after the backup, as asked."
    fi

    # 5. Swap. The old copy is kept (app.old) until the new one has started.
    new_version=$(head -n 1 "$new_dir/VERSION")
    say "Installing version $new_version..."
    rm -rf "$old_dir" "$root"/app.failed-*
    had_old=0
    old_version=""
    if [ -d "$app_dir" ]; then
        old_version=$(head -n 1 "$app_dir/VERSION" 2>/dev/null || true)
        mv "$app_dir" "$old_dir" || fail "Couldn't replace the old version. Restart the Mac and try again."
        had_old=1
    fi
    if ! mv "$new_dir" "$app_dir"; then
        [ -d "$old_dir" ] && [ ! -d "$app_dir" ] && mv "$old_dir" "$app_dir"
        fail "Couldn't install the new version. Restart the Mac and try again."
    fi

    # 6. A small app in ~/Applications that runs the launcher (it can be kept in the Dock).
    say "Creating Scrappy Records in $apps_dir..."
    mkdir -p "$apps_dir"
    app_bundle="$apps_dir/Scrappy Records.app"
    rm -rf "$app_bundle" "$apps_dir/Scrappy Records.command"
    run_cmd="cd $(printf '%s' "$app_dir" | sed "s/'/'\\\\''/g; s/^/'/; s/\$/'/") && ./python/bin/python3 -m app.launcher >/dev/null 2>&1 &"
    if osacompile -o "$app_bundle" -e "do shell script $(applescript_string "$run_cmd")" 2>/dev/null; then
        # Our icon. Newer macOS prefers the compiled Assets.car icon, so drop that.
        if sips -s format icns "$app_dir/scrappy.png" --out "$app_bundle/Contents/Resources/applet.icns" >/dev/null 2>&1; then
            rm -f "$app_bundle/Contents/Resources/Assets.car"
            /usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$app_bundle/Contents/Info.plist" >/dev/null 2>&1 || true
            codesign --force --sign - "$app_bundle" >/dev/null 2>&1 || true
            touch "$app_bundle"
        fi
        launcher="$app_bundle"
    else
        # No AppleScript compiler: fall back to a double-clickable Terminal script.
        launcher="$apps_dir/Scrappy Records.command"
        printf '#!/bin/sh\n%s\n' "$run_cmd" >"$launcher"
        chmod +x "$launcher"
    fi

    # 7. Open the new version and wait (up to 3 minutes) for it to answer as the new version
    #    (with --no-launch: check it can at least load). If it doesn't, put the old one back.
    started=0
    if [ "$no_launch" != "1" ]; then
        say "Opening Scrappy Records in your browser..."
        launched=1
        # After an update from the app, the launcher doesn't open a second tab if the old page
        # is still waiting (it reloads itself). No message boxes while this waits for it.
        [ "$from_app" != 1 ] || export SCRAPPY_AFTER_UPDATE=1
        launcher_ok=0
        (cd "$app_dir" && SCRAPPY_NO_DIALOG=1 ./python/bin/python3 -m app.launcher) && launcher_ok=1
        if wait_for_version "$new_version" "$launcher_ok" "$root"; then started=1; fi
    elif (cd "$app_dir" && ./python/bin/python3 -c 'import app.main') >/dev/null 2>&1; then
        started=1
    fi
    if [ "$started" != 1 ]; then
        [ "$had_old" = 1 ] ||
            fail "The new version ($new_version) didn't start. Run the install line again, or ask whoever set this up."
        say "Version $new_version didn't start: putting version $old_version back..."
        stop_running_app "$root"
        failed_dir="$root/app.failed-$(date +%Y%m%d%H%M%S)"
        { mv "$app_dir" "$failed_dir" && mv "$old_dir" "$app_dir"; } ||
            fail "The new version didn't start, and the old one couldn't be put back. Run the install line again."
        rm -rf "$failed_dir"
        [ "$from_app" = 1 ] || log_line "Version $new_version didn't start, so version $old_version was put back."
        if [ "$no_launch" != "1" ] || [ "$from_app" = 1 ]; then
            (cd "$app_dir" && ./python/bin/python3 -m app.launcher) >/dev/null 2>&1 || true
        fi
        launched=1 # opened (or not wanted): nothing more to open on the way out
        fail "The new version ($new_version) didn't start, so the previous version ($old_version) was put back and opened again."
    fi
    rm -rf "$old_dir"

    printf '\n\033[32mScrappy Records is installed\033[0m\n'
    printf 'From now on, open "Scrappy Records" from the Applications folder in your home folder.\n'
}

# Everything runs inside main, so a half-downloaded script can't run half the steps.
main "$@"
