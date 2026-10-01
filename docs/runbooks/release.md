# Releasing

Users install whatever the **latest GitHub Release** is. A release is created by pushing a
version tag.

> **Releases are immutable, and version tags are protected.** Once a release is published, its
> files can't be replaced, added or removed, and its tag can't be moved, deleted or used again
> (repository settings: *immutable releases*, and the *Protect release tags* ruleset on
> `refs/tags/v*`). So a release that fails, or turns out to be bad, is **never fixed in place**:
> fix `main`, **bump the patch version** (`0.2.0` → `0.2.1`) and release again. See
> [ADR 0006, Trust model](../adr/0006-in-app-update.md#trust-model).

## Before the first release: GitHub account safety

Whoever can publish a release can put code on the owner's laptop (the app updates itself to the
latest release). The account that publishes (the repository owner's) must have **two-factor
authentication** turned on: GitHub → Settings → Password and authentication → Two-factor
authentication (an authenticator app or a passkey; keep the recovery codes somewhere safe, not
on the same laptop). Don't add other people with write access to the repository; review what
goes into `main` before tagging.

## Steps

1. Make sure `main` is green in CI. In particular the `windows-install` and `macos-install` jobs,
   which install the real bundle and check that data survives a restart and an update, including
   an update started from inside the app (see [development](development.md#testing-the-install)).
   **Write the release notes for the owner**: the app shows them, as plain text, under **See
   what's new** (auto-generated notes list commit titles; replace or lead them with a few plain
   sentences).
2. Bump the version in `backend/pyproject.toml` (`version = "0.2.0"`), and run `uv lock` in
   `backend/` so the lockfile picks up the new project version. Commit via a PR.
3. Tag and push:
   ```bash
   git checkout main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```
4. The `release` workflow (`.github/workflows/release.yml`):
   - checks that the tag matches the version in `backend/pyproject.toml`, and stops if not;
   - checks that **every earlier release has its saved-data sample** in
     `backend/tests/fixtures/releases/` (step 8), and stops if not, naming the missing ones
     (`scripts/ci/check_release_fixture.py`). The first time, that's `v0.1.0`'s sample, which
     must be on `main` before `v0.1.1` can be released. Only `vMAJOR.MINOR.PATCH` tags are
     releases: a tag like `v1.0.0-rc1` is refused with a message, and isn't counted as an
     earlier release;
   - checks that every migration only adds (`scripts/ci/check_migrations_only_add.py`);
   - runs the backend and frontend unit tests;
   - builds the UI once, and shares it with the next two jobs;
   - builds `scrappy-records-windows-x64.zip` on `windows-latest` and
     `scrappy-records-macos-arm64.zip` on `macos-latest` with `scripts/build_bundle.py`, which
     self-tests each bundle (unzips it and starts the server from it with no developer tools);
   - runs the same install smoke tests as CI on each (`scripts/ci/smoke_install_windows.ps1`,
     `scripts/ci/smoke_install_mac.sh`);
   - only if all of that passed, creates the GitHub Release **as a draft** with auto-generated
     notes and every file: both zips, `install.ps1`, `install.sh` (Update now runs the new
     release's own installer) and `SHA256SUMS` covering all four. Files can only be added
     before publishing (immutable releases);
   - **publishes it as a prerelease**. Its files can't change from now on. The install line
     downloads `releases/latest/download/...` and the app's update check reads
     `releases/latest`, which both skip prereleases, so users still get the previous version;
   - **checks the prerelease** on a fresh Windows machine with the `-Version <tag>` form
     (`post-release-verify.yml`, mode `tagged`): install, restart, update, data kept;
   - **checks Update now with the real files** on Windows and macOS (`verify-in-app`): an
     installed older copy is offered this tag, downloads `install.ps1` / `install.sh` and
     `SHA256SUMS` from `releases/download/<tag>/`, checks them, and its installer downloads
     and checks the real zip (`scripts/ci/smoke_in_app_update.py --release-tag <tag>`);
   - only then **promotes** it (`gh release edit <tag> --prerelease=false --latest`);
   - **checks the plain install line** (mode `latest`): the literal line from the docs must now
     install this version; then restart, update and `-Version`;
   - if that last check fails, **rolls back**: the release becomes a prerelease again, so
     `latest` points at the previous version. A failed check never leaves a bad "latest".
     (Checked on a test repository: on an immutable release, `--prerelease=false --latest` and
     `--prerelease` still work, and the notes can still be edited; only the files and the tag
     are locked.)
5. Watch the whole workflow go green in the Actions tab. The release page must show the new
   version as **Latest**, with its five files. (The check can be re-run by hand: Actions →
   Post-release check → Run workflow, with `mode` `latest` or `tagged`.)
6. **Check it on a real Windows laptop.** This is required before the owner's first install,
   and after any release that changes the installer, launcher or backups; otherwise it's
   optional. Follow [release-acceptance-test.md](release-acceptance-test.md): a 10-minute
   checklist that a person does, since no automated test can reach a real laptop. Record the
   result in its table.
7. **The owner's laptop updates itself.** Once the release is **Latest**, the app shows "A new
   version (X) is ready" within 12 hours (it checks when it starts and every 12 hours; **⚙
   Settings → About → Check for updates** looks at once), and she clicks **Update now**
   ([update.md](update.md)). A prerelease is never offered. The update **to v0.2.0** is the
   exception: v0.1.0 has no button, so that one time she pastes the install line. For the very
   first install, follow [install-windows.md](install-windows.md).
8. **Save this release's data sample.** After releasing vX, run
   `scripts/make_release_fixture.py vX` and commit it via a PR:
   ```bash
   git checkout main && git pull && git checkout -b chore/release-fixture-v0.2.0
   python3 scripts/make_release_fixture.py v0.2.0
   git add backend/tests/fixtures/releases/ && git commit -m "test: v0.2.0 release fixture"
   ```
   It checks the tag out into a temporary folder, fills a new database through *that*
   release's own code (fictional data), and writes `v0.2.0.db` (well under 200 KB) and
   `v0.2.0.json` (every row it holds). From then on, every PR upgrades it with the new code and
   checks nothing was lost or changed ([ADR 0004](../adr/0004-data-is-never-lost.md)). The next
   release can't be published until it's on `main`. If this release added a new kind of stored
   data, first add it to `scripts/release_fixture_populate.py` (guarded, so older tags still
   work), so the sample covers it.

If the tests, a bundle or a smoke test fail before publishing, nothing is published (at
most a draft is left: delete the draft; the tag stays, so the next attempt still needs a new
version). If a check fails after publishing, the release stays (or goes back to being) a
prerelease that users never get. **Either way: fix the problem on `main`, bump the patch
version and tag the new version.** A published release can't be changed, and its tag can't be
deleted, moved or reused, even after deleting the release. Leave the failed prerelease as it
is (it's never offered), or edit its notes to say it was replaced.

## Checking a bundle before tagging

On a Mac:

```bash
make package                                             # UI, bundle, self-test
scripts/ci/smoke_install_mac.sh dist/scrappy-records-macos-arm64.zip
uv run --project backend python scripts/build_bundle.py --platform windows-x64   # cross-build, no self-test
```

The Windows bundle can only be run on Windows. CI's `windows-install` job does that on every PR.

## Updating the bundled Python

`scripts/build_bundle.py` pins a python-build-standalone release (`PBS_RELEASE`,
`PYTHON_VERSION`) and the SHA-256 of each platform's `install_only` archive. To update, pick a
newer release, copy both checksums (from the release's `SHA256SUMS`, or
`gh api repos/astral-sh/python-build-standalone/releases/tags/<tag>`), and let CI's install
jobs prove it works. Stay on 3.12, matching `requires-python`.

## Compatibility with older installs

The pasted line fetches `install.ps1` and `install.sh` from `main`; **Update now** uses the
ones published with the new release. Either way the zip is checked against the release's
`SHA256SUMS` (only v0.1.0, from before checksums, has none). Either way, before an update they run the *installed* (possibly
older) version's `python -m app.backup --reason pre-update`. Keep that command, and its meaning
(exit code 0 = backed up, or nothing to back up), working in every release. The installer falls
back to the new version's backup, then to a file copy, if it fails.

## Updating from inside the app: what must keep working

With **Update now** ([ADR 0006](../adr/0006-in-app-update.md)), an **older app starts a newer
installer**, and an **older page waits on a newer server**. Every future release must keep
supporting the oldest app still in use (v0.2.0 onwards), so these are a contract:

1. **The installer's command line.** Windows: the app downloads
   `https://github.com/srikdhruv/scrappy-business-records/releases/download/<tag>/install.ps1`
   (the **new** release's own file) and `SHA256SUMS` next to it, checks the one against the
   other, and runs
   `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <tmp>\install.ps1 -Version <tag>`.
   macOS: `.../releases/download/<tag>/install.sh`, run as `/bin/sh <tmp>/install.sh --version <tag>`.
   Keep `-Version` / `--version`, and don't add a *required* parameter. Every release must
   publish `install.ps1`, `install.sh` and a `SHA256SUMS` covering them (`release.yml` does;
   `backend/tests/test_release_contract.py` fails if the scripts move or stop being published).
2. **Its environment.** `SCRAPPY_UPDATE_FROM_APP=1` (started from the app) and
   `SCRAPPY_INSTALL_ROOT` (the folder holding the running `app`); in CI only (with
   `SCRAPPY_TEST_MODE=1`), `SCRAPPY_INSTALL_DOWNLOAD_URL`. Keep honouring them. The rest of the
   app's environment is passed on.
3. **No questions, no window.** It runs detached, with no console, no one to answer, and its
   output in `logs/update.log`. Nothing may prompt or wait for a key. `exit` is fine here (it only
   ends that PowerShell), but the pasted line still needs `throw`, so keep using `throw`.
4. **It ends with the app open.** On success, open the new version, with `SCRAPPY_AFTER_UPDATE=1`
   for the launcher, and keep the old one until the new one answers as itself (else put the
   old one back). If it fails after closing the app, open the version still installed. Print
   the reason on a `Details: ...` line: the app shows it as the technical detail.
5. **The server's side.** The new server must keep answering `GET /api/health` with
   `{"app": "scrappy-records", "version": ...}` and accepting `?waiting_for_update=true`, which the
   old page polls (from `127.0.0.1:<port>`, which every request must be addressed to); and keep
   reading `logs/update-attempt.json` (`from_version`, `to_version`, `tag`, `started_at`,
   `outcome`, `finished_at`, `detail`, and the newer `technical`), written by the old server,
   to say whether it worked.
6. **The release itself.** Keep the file names (`scrappy-records-windows-x64.zip`,
   `scrappy-records-macos-arm64.zip`, `install.ps1`, `install.sh`, `SHA256SUMS`): the app only
   offers a release that has this computer's zip, its installer and `SHA256SUMS`. Tags stay
   `vMAJOR.MINOR.PATCH` (ASCII digits); anything else is never offered.

CI checks this on every PR (`scripts/ci/smoke_in_app_update.py`, in the install jobs): an install
of this commit's bundle, labelled 0.0.1, updates itself to the same bundle through
`/api/update/start` with this commit's installer, served with a `SHA256SUMS` from a local
stand-in for GitHub, including tampered files, a failure after the backup and a new version
that won't start. `release.yml` repeats the update with the real release files before
promoting. Both test *this* installer being started by *this* app's server; an installer change
that would break an older app's call (a new required parameter, say) must be caught in review
against the list above.

> **Follow-up once v0.2.0 is released:** make the "old" copy in `smoke_in_app_update.py` the
> real v0.2.0 zip (downloaded from its release, checked against its `SHA256SUMS`) instead of
> this commit's bundle relabelled 0.0.1, in both the PR jobs and `release.yml`'s
> `verify-in-app`. Then every PR proves the *oldest* app with the button can still update to
> the new installer (future-features §9).

## How the app finds out about a release

The app reads `https://api.github.com/repos/srikdhruv/scrappy-business-records/releases/latest`
at startup and every 12 hours. GitHub's "latest" is the newest release that is **not** a draft or
a prerelease: that's why `release.yml` publishes as a prerelease first and only promotes a
release after checking it. Rolling a release back to prerelease also stops it being offered
(anyone who already updated keeps it). To offer nothing for a while, leave the release as a
prerelease.

## Why asset names have no version

`install.ps1` downloads
`https://github.com/srikdhruv/scrappy-business-records/releases/latest/download/scrappy-records-windows-x64.zip`.
With a fixed asset name, that URL always points at the newest release, with no API call and no
parsing. The version is in the bundle's `VERSION` file and at `/api/health`.

## Rolling back

The app never offers an older version, so going back is always the pasted line. Install a
specific version:

```powershell
[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; & ([scriptblock]::Create((irm https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.ps1))) -Version v0.1.0
```

On a Mac: `curl -fsSL https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.sh | sh -s -- --version v0.1.0`.

⚠️ If the newer version ran a database migration, the older app may not understand the
upgraded database. In that case also restore the `records-pre-update-*.db` backup taken just
before the update (see [backup-and-restore.md](backup-and-restore.md)).

## Hotfix

Branch from `main`, fix, open a PR, merge, bump the patch version and tag. There are no
long-lived release branches.

If a hotfix ever has to be cut from an older tag instead (say `v0.3.1` from `v0.3.0` while
`main` is ahead), that branch doesn't have the saved-data samples committed after `v0.3.0`, and
the release stops. Cherry-pick the commits that added them onto the hotfix branch before
tagging; on `main`, `git log --oneline -- backend/tests/fixtures/releases/` lists them. Samples
of releases newer than the hotfix aren't needed there.
