# ADR 0003 — Distribution: self-contained zip + one-line PowerShell installer

- **Status:** Accepted
- **Date:** 2026-09-29

## Context

The target laptop may have **nothing** installed: no Python, uv, Node, git or Docker. The user
can, at most, paste one line into PowerShell. Updates must preserve their data.

## Decision

CI builds a **self-contained bundle** for each platform and attaches it to a GitHub Release.
For Windows the bundle is `scrappy-records-windows-x64.zip`. It contains:

- a pinned, relocatable **python-build-standalone** CPython;
- every dependency preinstalled into its `site-packages`, from `uv export --frozen`;
- the backend package, including migrations;
- the built React UI in `app/static/`;
- `VERSION`, the app icon (`scrappy.ico`, `scrappy.png`) and `Start Scrappy Records.cmd`;
- a `.pth` file in `site-packages` that puts the bundle folder on `sys.path`, so
  `python -m app.launcher` works whatever the current folder is.

The macOS bundle is `scrappy-records-macos-arm64.zip`, with the same contents, and
`scripts/install.sh` creates a small `Scrappy Records.app` in `~/Applications` to open it.

The asset names carry no version, so
`https://github.com/<owner>/<repo>/releases/latest/download/scrappy-records-windows-x64.zip`
always points at the newest build.

**Install and update** is a single command:

```powershell
[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.ps1 | iex
```

`install.ps1` is idempotent, needs no admin rights, and uses only built-in Windows tools. It:

1. enables TLS 1.2 (the install line does this too, before its own download, because older
   Windows 10 doesn't offer TLS 1.2 by default and GitHub requires it);
2. downloads the zip to `%TEMP%` and extracts it to a staging folder (`app.new`);
3. stops any running Scrappy Records server (a polite stop request first, force after 10 s);
4. takes a pre-update backup using the *old* bundle's Python, else the new one's, else a copy of
   the database file with its journal; if none works, it stops without changing anything;
5. swaps the staging folder into `%LOCALAPPDATA%\ScrappyRecords\app` (never touching `data\`);
6. creates the Desktop shortcut;
7. deletes the zip;
8. launches the app.

Piping into `iex` isn't blocked by the default script execution policy, because no `.ps1` file is
run from disk.

## Alternatives considered

- **Install uv at install time and let it fetch Python and the packages.**
  - For: a smaller download.
  - Against: it depends on four online services (astral.sh, GitHub, the Python mirror, PyPI) and
    resolves packages on the user's machine. There are more ways to fail, and none the user could debug.
- **`git clone`, then a script.** Git isn't on stock Windows, and a user-facing clone adds
  nothing.
- **PyInstaller single `.exe`.** Slow startup (it unpacks to temp each run), frequent antivirus
  false positives, and harder to debug.
- **A signed MSI or MSIX installer.** The best experience, but it needs a code-signing
  certificate and more CI. Deferred (future-features §9).

## Consequences

- Downloads are larger (about 25 MB for Windows, 32 MB for macOS), and we build once per platform
  (windows-x64 first, macOS arm64 as secondary).
- What runs on the user's laptop is exactly the artifact CI tested. What CI covers, and what it
  doesn't:
  - On every PR, `windows-install` builds the bundle and installs it with Windows PowerShell 5.1
    on a runner with no Python on its PATH, from the local zip (the `-ZipPath` test hook), into
    a folder whose name has a space, an apostrophe and non-English letters. It checks restart,
    update, a crash mid-save, the friendly message for a release that doesn't exist, and more
    (see the development runbook). `macos-install` does the same on a Mac.
  - The literal published command (`irm` of `main`'s `install.ps1` from
    raw.githubusercontent.com, and the `releases/latest/download/` asset) can only be tested
    once a release exists. `release.yml` publishes each release as a prerelease, checks it on
    Windows with `-Version`, only then makes it "latest", checks the literal line, and turns it
    back into a prerelease if that fails (`post-release-verify.yml`).
  - Not covered: the real Desktop of a user whose Desktop is redirected to OneDrive (handled
    with `GetFolderPath('Desktop')`), antivirus products, and very old Windows 10 builds.
- The Start Menu entry and an Edge `--app` window are deferred. The MVP has a Desktop shortcut
  only.
