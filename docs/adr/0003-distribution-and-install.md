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
- `VERSION` and `Start Scrappy Records.cmd`.

The asset names carry no version, so
`https://github.com/<owner>/<repo>/releases/latest/download/scrappy-records-windows-x64.zip`
always points at the newest build.

**Install and update** is a single command:

```powershell
irm https://raw.githubusercontent.com/srikdhruv/scrappy-business-records/main/scripts/install.ps1 | iex
```

`install.ps1` is idempotent, needs no admin rights, and uses only built-in Windows tools. It:

1. enables TLS 1.2;
2. downloads the zip to `%TEMP%`;
3. stops any running Scrappy Records server;
4. takes a pre-update backup using the *old* bundle's Python, if an install exists;
5. extracts the zip to a staging folder and swaps it into
   `%LOCALAPPDATA%\ScrappyRecords\app` (never touching `data\`);
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

- Downloads are larger (about 40–60 MB), and we build once per platform (windows-x64 first, macOS
  arm64 as secondary).
- What runs on the user's laptop is exactly the artifact CI tested. A Windows CI job installs the bundle
  on a runner with no Python on its PATH and checks it.
- The Start Menu entry and an Edge `--app` window are deferred. The MVP has a Desktop shortcut
  only.
