# Releasing

Users install whatever the **latest GitHub Release** is. A release is created by pushing a
version tag.

## Steps

1. Make sure `main` is green in CI. In particular the `windows-install` and `macos-install` jobs,
   which install the real bundle and check that data survives a restart and an update (see
   [development](development.md#testing-the-install)).
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
   - runs the backend and frontend unit tests;
   - builds the UI once, and shares it with the next two jobs;
   - builds `scrappy-records-windows-x64.zip` on `windows-latest` and
     `scrappy-records-macos-arm64.zip` on `macos-latest` with `scripts/build_bundle.py`, which
     self-tests each bundle (unzips it and starts the server from it with no developer tools);
   - runs the same install smoke tests as CI on each (`scripts/ci/smoke_install_windows.ps1`,
     `scripts/ci/smoke_install_mac.sh`);
   - only if all of that passed, creates the GitHub Release with auto-generated notes and both
     zips, **as a prerelease**. The install line downloads `releases/latest/download/...`, which
     skips prereleases, so users still get the previous version at this point;
   - **checks the prerelease** on a fresh Windows machine with the `-Version <tag>` form
     (`post-release-verify.yml`, mode `tagged`): install, restart, update, data kept;
   - only then **promotes** it (`gh release edit <tag> --prerelease=false --latest`);
   - **checks the plain install line** (mode `latest`): the literal line from the docs must now
     install this version; then restart, update and `-Version`;
   - if that last check fails, **rolls back**: the release becomes a prerelease again, so
     `latest` points at the previous version. A failed check never leaves a bad "latest".
5. Watch the whole workflow go green in the Actions tab. The release page must show the new
   version as **Latest**, with both assets. (The check can be re-run by hand: Actions →
   Post-release check → Run workflow, with `mode` `latest` or `tagged`.)
6. **Check it on a real Windows laptop.** This is required before the owner's first install,
   and after any release that changes the installer, launcher or backups; otherwise it's
   optional. Follow [release-acceptance-test.md](release-acceptance-test.md): a 10-minute
   checklist that a person does, since no automated test can reach a real laptop. Record the
   result in its table.
7. Update the owner's laptop: follow [update.md](update.md), or ask them to run the install line
   again. For the very first install, follow [install-windows.md](install-windows.md).

If the tests, a bundle or a smoke test fail, nothing is published. If a check fails, the
release stays (or goes back to being) a prerelease that users never get. Either way: fix the
problem on `main`, delete the release and the tag
(`gh release delete v0.2.0 --yes; git push --delete origin v0.2.0 && git tag -d v0.2.0`), and
tag again.

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

`install.ps1` and `install.sh` are always fetched from `main`, but before an update they run the
*installed* (possibly older) version's `python -m app.backup --reason pre-update`. Keep that
command, and its meaning (exit code 0 = backed up, or nothing to back up), working in every
release. The installer falls back to the new version's backup, then to a file copy, if it fails.

## Why asset names have no version

`install.ps1` downloads
`https://github.com/srikdhruv/scrappy-business-records/releases/latest/download/scrappy-records-windows-x64.zip`.
With a fixed asset name, that URL always points at the newest release, with no API call and no
parsing. The version is in the bundle's `VERSION` file and at `/api/health`.

## Rolling back

Install a specific version:

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
