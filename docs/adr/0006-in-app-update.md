# ADR 0006 — Updating from inside the app, and the update check

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amends:** [ADR 0005](0005-feedback-is-the-only-outbound-call.md) (feedback was the only
  outbound call) and [ADR 0003](0003-distribution-and-install.md) (updates by pasting a line)

## Context

Until now the owner updated by pasting a PowerShell line
([update runbook](../runbooks/update.md)). She isn't technical, and asked for an "Update
available" notice with an "Update" button, so that the update to v0.2.0 is the last time she
pastes anything. To offer a new version, the app has to find out that one exists: a second
outbound call, besides feedback.

## Decision

1. **The update check is the app's second outbound call, and it only reads.** The server asks
   GitHub for the latest release, `GET
   https://api.github.com/repos/srikdhruv/scrappy-business-records/releases/latest`
   (`UPDATE_FEED_URL` in `backend/app/config.py`), unauthenticated, with a 15 s timeout and a
   `User-Agent` of `scrappy-records/<version> (update check)`. Nothing about the owner, her
   records or this laptop is sent: GitHub sees an ordinary request for public information from
   her internet address, like opening the releases page in a browser. The installer's download
   (below) is the same kind of public read.
2. **When it looks.** At startup, then every 12 hours (an hour after a failed try), and when
   the owner clicks Settings → About → **Check for updates**. It measures time with the wall
   clock, so a laptop that sleeps still checks. If GitHub says to wait (403 with
   `X-RateLimit-Remaining: 0`, or 429), it waits until the time GitHub gives, at most a day.
   The answer is cached in memory; the page reads it from `GET /api/update`, which never waits
   for the internet.
3. **What counts as a new version.** GitHub's `releases/latest` skips drafts and prereleases,
   and the release pipeline only promotes a release to latest after checking it
   ([release runbook](../runbooks/release.md)). The app also ignores anything marked draft or
   prerelease, or whose tag isn't a plain `vMAJOR.MINOR.PATCH`, compares versions the semver
   way (`backend/app/versions.py`: 0.10.0 is newer than 0.9.0), and only offers a release that
   has this computer's download (`scrappy-records-windows-x64.zip` or
   `scrappy-records-macos-arm64.zip`), its installer and its `SHA256SUMS`. Version numbers are
   ASCII digits only. Just before starting an update the app asks GitHub again, so a release
   pulled since the banner appeared is never installed (if it can't ask, it doesn't start).
4. **Update now runs the new release's own installer, checked.** `POST /api/update/start`
   downloads `install.ps1` (Windows) or `install.sh` (macOS) from **the new release's files**
   (`https://github.com/<repo>/releases/download/<tag>/`, published with the release by
   `release.yml`), so the installer always matches the release it installs, and checks it
   against that release's `SHA256SUMS` before running it (a mismatch or a missing entry: `424`,
   nothing changed). The installer in turn checks the zip against `SHA256SUMS` before
   unpacking it. It then starts the installer **on its own** (Windows: `CREATE_NEW_PROCESS_GROUP` and
   `CREATE_NO_WINDOW`, leaving a job object if allowed; macOS: its own session), so it survives
   the server being stopped by that same installer. (Not `DETACHED_PROCESS`: CI showed Windows
   PowerShell 5.1 with no console at all exits at once without running the script;
   `CREATE_NO_WINDOW` gives it a console that is never shown.)
   `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <tmp>\install.ps1 -Version <tag>`
   or `/bin/sh <tmp>/install.sh --version <tag>`, with `SCRAPPY_UPDATE_FROM_APP=1` and
   `SCRAPPY_INSTALL_ROOT` set, its output in `logs/update.log`. The installer does what it
   always does: stop the app politely, back up, swap in the new version (never touching the
   data folder, [ADR 0004](0004-data-is-never-lost.md)), open it, recreate the shortcut.
   Nothing new runs with more rights than the owner has.
5. **Only the app's own page can start an update.** `POST /api/update/start` (and `/check`)
   need `Content-Type: application/json` and an `X-Scrappy-Request: 1` header, and refuse a
   `Host` that isn't `127.0.0.1:<port>`/`localhost:<port>` and an `Origin` or
   `Sec-Fetch-Site` that says another website sent it. A web page elsewhere can't send those
   (a form can't set the content type; a script needs a CORS preflight the server never
   approves), and DNS rebinding fails the `Host` check. The request also names the version the
   page showed, which must be the latest. One update at a time: a second start is refused
   (`409`), in the server and by the page.
6. **The page follows it to the end.** The page shows "Updating… the app will reopen in a
   minute" and polls `/api/health?waiting_for_update=true` every 2 s. A different version
   answering → reload (the new version's UI). The same version answering and
   `/api/update` saying this attempt failed → say so in plain words, with the log's location.
   Nothing after 15 minutes (longer than the installer waits for a slow start) → say what to do; that window never shows the Updating screen for
   that attempt again. The attempt is written to `logs/update-attempt.json` before the installer
   starts; the next server to start settles it (its own version is the new one → succeeded;
   else failed), the server marks it failed itself if the installer ends while it still runs,
   and an attempt still "running" after 30 minutes is failed (Update now works again). The
   message is in plain words; the installer's own line is kept apart, as a small folded
   "Technical details". After a failed or interrupted update (a restart in the middle, say),
   the page says once "The last update didn't finish — your records are safe", with Try again.
7. **It always ends with the app open, and an update that won't start is undone.** If the
   installer fails before swapping (download, checksum, backup), nothing was changed; started
   from the app, it opens the version still installed if it had closed it. If the swap itself
   fails, the old folder is put back. After the swap, the old version is kept (`app.old`) until
   the new one answers `/api/health` **as the new version**. A first start can be slow (an
   antivirus scan, a backup and an upgrade first), so the installer keeps waiting, up to 10
   minutes, while any of the new version's programs is running, and gives up early only once
   none is left (it crashed); with `-NoLaunch` it must at least import. **Once the new version
   has answered, nothing is undone** (she may have used it). If it never answers, the installer
   stops it, puts the old version back (each move is checked: if the old one can't come back,
   the new one is put back in place, so there's always an app, and it says so), opens it, logs
   every step (`logs/update.log`) and says so. **If that failed start changed the records** (a
   fingerprint of `records.db` and its journal, taken right after this run's backup, differs:
   an upgrade ran, then a crash), it also puts the pre-update backup back: ADR 0004's one
   documented exception, decided by the owner. The changed records are kept aside as
   `records-failed-update-<time>.db`, the restored copy must pass `PRAGMA integrity_check`, and
   if the restore fails it's undone and the old version isn't opened on records it may not
   read. The page then says "The last update didn't finish — your records were put back as they
   were before the update" (`records_restored`, from the installer's line "Your records were put
   back as they were before the update." in `update.log`). This is the installer's own logic,
   so it also protects the pasted line (including the v0.1.0 → v0.2.0 update, which uses
   `main`'s installer), on Windows and macOS. After an update, the launcher doesn't open a second browser tab if the page that
   started it is still waiting (`page_waiting` in `/api/update`, set by the page's
   `waiting_for_update` polls); otherwise it opens the browser as usual.
8. **Switches for tests and dev.** `SCRAPPY_UPDATE_FEED_URL` overrides the feed (empty turns
   the check off: dev mode, the unit tests, the bundle self-test and the guide pictures). The
   test hooks work **only with `SCRAPPY_TEST_MODE=1`** (CI sets it), and are ignored otherwise,
   in the app and in the installers: plain HTTP (only to this laptop: `127.0.0.1` or
   `localhost`), the installers' `SCRAPPY_TEST_FORCE_FILE_COPY_BACKUP` and
   `SCRAPPY_TEST_FAIL_AFTER_BACKUP`, and
   `SCRAPPY_UPDATE_DOWNLOAD_URL` (a local stand-in for a release's files, passed on to the
   installer as `SCRAPPY_INSTALL_DOWNLOAD_URL`). There is no way to hand the update a local zip.
   A copy running from source (not an installed bundle) never updates itself.

## Trust model

Updating means running code from GitHub on the owner's laptop. What makes that safe enough:

- **Immutable releases** (a repository setting): once a release is published, its files can't
  be replaced, added or removed, and its tag can't be moved or reused, even by the repo's
  owner. `release.yml` therefore attaches every file to a draft and only then publishes it.
- **Protected release tags** (the "Protect release tags" ruleset on `refs/tags/v*`): no
  deleting, moving or force-pushing a version tag.
- **Checksums.** Every release has `SHA256SUMS` for both zips and both installers. The app
  checks the installer, and the installer checks the zip, before using them. The pasted line
  (which fetches `install.ps1` from `main`) checks the zip too. Only v0.1.0, from before
  checksums, has none, and is only installed unchecked when asked for by name
  (`-Version v0.1.0`); the latest path always needs `SHA256SUMS`.
- **Only checked releases become "latest".** A new release is a prerelease until it has been
  installed and updated to by the real files on Windows and macOS; the app only offers
  "latest".
- **2FA on the owner's GitHub account**, which is required to publish (see the
  [release runbook](../runbooks/release.md#before-the-first-release-github-account-safety)).

What it protects against: a file swapped or damaged after publishing (on GitHub, a mirror, a
proxy, or a cut-short download); a tag moved to other code; a release published by mistake
reaching the laptop before it's checked; another website starting an update; an update that
won't start leaving her without the app.

What it doesn't: someone who controls the owner's GitHub account (or the repository) and
publishes a new, bad release through the normal process, with matching checksums (2FA and
review of what goes on `main` are the defence); a fault in the code itself that the release
checks miss; and a compromised laptop. The checksums come from the same place as the files, so
they prove the files are the ones published, not who published them; signing releases is a
later step (future-features §9).

## Compatibility

An older app starts a newer installer, and a newer server answers an older page. What must keep
working in every release is listed in the
[release runbook](../runbooks/release.md#updating-from-inside-the-app-what-must-keep-working).

## Alternatives considered

- **Check from the browser.** It would leak the owner's browser details to GitHub, need a CORS
  exception, and couldn't start the installer anyway.
- **A static `latest.json` on our own site, or GitHub Pages.** One more thing to publish and
  keep in step with releases; `releases/latest` already is that file.
- **Download the zip in the server and swap files itself.** The running server can't replace its
  own files on Windows, and the installer already does the stop, backup, swap and rollback
  well, tested on every pull request. Running it keeps one path for installing and updating.
- **The installer from the raw tag path** (`raw.githubusercontent.com/<repo>/<tag>/...`), as
  first built. It always matches the release too, but isn't covered by the release's
  immutability or its checksums; the release's own files are.
- **Automatic updates without asking.** The owner wants to choose the moment (not in the middle
  of logging payments), and a surprise restart would break her trust. The banner can wait.
- **A signed installer with its own updater (MSIX, Squirrel).** Needs a code-signing
  certificate and more infrastructure (future-features §9).

## Consequences

- The app now talks to GitHub twice a day when online. If GitHub is down or blocked, nothing
  else is affected: the banner just doesn't appear, and About says it couldn't check.
- **The v0.2.0 update is the last pasted line.** Every later update starts from the button.
- Each release's installer becomes part of the app's behaviour: a broken `install.ps1` in a
  release breaks updating *to* that release. CI updates a real install with this commit's
  installer, from the app, on Windows and macOS (`scripts/ci/smoke_in_app_update.py`, in the
  `windows-install` and `macos-install` jobs), including tampered files and a new version that
  won't start; `release.yml` does it again with the real release files before promoting a
  release; and the pasted line stays as the fallback.
- **A bad release can't be fixed in place.** Its files can't change and its tag can't be
  reused: fix `main`, bump the patch version and release again.
- The release notes are shown to the owner under **See what's new**, as plain text: write them
  for her.
