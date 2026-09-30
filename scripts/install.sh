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
#
# Same steps as scripts/install.ps1: download and unpack to app.new, stop the running app, back
# up the data, swap app.new in for app (the data folder is never touched), create the launcher,
# delete the download, open the app.

set -eu

REPO="srikdhruv/scrappy-business-records"
ASSET="scrappy-records-macos-arm64.zip"
HELP_URL="https://github.com/$REPO/blob/main/docs/runbooks/troubleshooting.md"

say() { printf '  - %s\n' "$*"; }

fail() {
    printf '\n\033[31mSorry, Scrappy Records was NOT installed. Your data has not been changed.\033[0m\n' >&2
    printf '%s\n' "$*" >&2
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

applescript_string() {
    # Quote a value for an AppleScript string literal.
    printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"
}

main() {
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

    # 1. Get the zip.
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/scrappy-install.XXXXXX")
    trap 'rm -rf "$tmp"' EXIT
    if [ -n "$zip_path" ]; then
        [ -f "$zip_path" ] || fail "No such file: $zip_path"
        say "Using $zip_path"
    else
        if [ -n "$version" ]; then
            case "$version" in v*) ;; *) version="v$version" ;; esac
            url="https://github.com/$REPO/releases/download/$version/$ASSET"
        else
            url="https://github.com/$REPO/releases/latest/download/$ASSET"
        fi
        zip_path="$tmp/$ASSET"
        say "Downloading Scrappy Records (about 30 MB, this can take a minute)..."
        if ! curl -fL --retry 3 --silent --show-error -o "$zip_path" "$url"; then
            fail "The download failed or was not found. Check the internet connection and try again; if it keeps failing, the release may not be published yet."
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

    # 5. Swap.
    say "Installing version $(head -n 1 "$new_dir/VERSION")..."
    rm -rf "$old_dir"
    if [ -d "$app_dir" ]; then
        mv "$app_dir" "$old_dir" || fail "Couldn't replace the old version. Restart the Mac and try again."
    fi
    if ! mv "$new_dir" "$app_dir"; then
        [ -d "$old_dir" ] && [ ! -d "$app_dir" ] && mv "$old_dir" "$app_dir"
        fail "Couldn't install the new version. Restart the Mac and try again."
    fi
    rm -rf "$old_dir"

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

    # 7. Open the app.
    if [ "$no_launch" != "1" ]; then
        say "Opening Scrappy Records in your browser..."
        (cd "$app_dir" && ./python/bin/python3 -m app.launcher) ||
            say "The app didn't open by itself. Open it from $apps_dir."
    fi

    printf '\n\033[32mScrappy Records is installed\033[0m\n'
    printf 'From now on, open "Scrappy Records" from the Applications folder in your home folder.\n'
}

# Everything runs inside main, so a half-downloaded script can't run half the steps.
main "$@"
