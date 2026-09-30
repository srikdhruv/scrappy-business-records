# Releasing

Users install whatever the **latest GitHub Release** is. A release is created by pushing a
version tag.

## Steps

1. Make sure `main` is green in CI.
2. Bump the version in `backend/pyproject.toml` (`version = "0.2.0"`), and run `uv lock` so the
   lockfile picks up the new project version. Commit via a PR.
3. Tag and push:
   ```bash
   git checkout main && git pull
   git tag v0.2.0
   git push origin v0.2.0
   ```
4. The `release` workflow:
   - builds the UI;
   - builds `scrappy-records-windows-x64.zip` on `windows-latest` and
     `scrappy-records-macos-arm64.zip` on `macos-latest`;
   - smoke-tests each bundle: starts the server from the bundle and checks `/api/health`;
   - creates the GitHub Release with auto-generated notes, and attaches both zips.
5. Check the release page. Both assets must be present.
6. Update the user's laptop: follow [update.md](update.md), or ask them to run the install line
   again.

## Why asset names have no version

`install.ps1` downloads
`https://github.com/srikdhruv/scrappy-business-records/releases/latest/download/scrappy-records-windows-x64.zip`.
With a fixed asset name, that URL always points at the newest release, with no API call and no
parsing. The version is in the bundle's `VERSION` file and at `/api/health`.

## Rolling back

Install a specific version:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.ps1))) -Version v0.1.0
```

⚠️ If the newer version ran a database migration, the older app may not understand the
upgraded database. In that case also restore the `records-pre-update-*.db` backup taken just
before the update (see [backup-and-restore.md](backup-and-restore.md)).

## Hotfix

Branch from `main`, fix, open a PR, merge, bump the patch version and tag. There are no
long-lived release branches.
