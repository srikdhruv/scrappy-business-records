# ADR 0002 — Local-only, single-process runtime (no Docker, no DB server)

- **Status:** Accepted
- **Date:** 2026-09-29

## Context

The user is non-technical, on a Windows laptop, and must be able to open the app with a
double-click. Their data must persist between sessions and must never leave the laptop.

## Decision

- Run **one process**: uvicorn serving FastAPI on `127.0.0.1:8765`. The same process serves the
  prebuilt React UI as static files.
- Store data in **SQLite** at `%LOCALAPPDATA%\ScrappyRecords\data\records.db`.
- A **launcher** (run by `pythonw.exe`, so no console appears) does three things:
  - health-checks the server;
  - starts it detached if it isn't running;
  - opens the default browser at the app URL.
- The server stays running in the background until logoff.
- Run Alembic migrations automatically at startup, after taking a backup.
- Take a daily backup into `Documents\ScrappyRecords Backups` using SQLite's online backup API,
  and keep 30 days.
- Keep the live database **outside** Documents, which may be synced by OneDrive; syncing a live
  SQLite file can corrupt it.

## Alternatives considered

- **Docker Compose.** Docker Desktop on Windows requires admin rights, WSL2, BIOS virtualization,
  several GB of disk and a background VM using RAM. That is unacceptable for this user, and
  pointless for a single service.
- **Postgres or MySQL.** An extra server to install, run and back up, for no benefit at this
  scale.
- **Hosted web app.** Needs accounts, hosting cost and internet access, and puts financial data
  in the cloud. The user asked for local.
- **Stopping the server when the browser tab closes.** More moving parts (heartbeats), and a
  risk of killing an open session. Leaving an idle process running costs only about 50 MB of RAM.

## Consequences

- There is zero network exposure, and no auth is needed.
- The app makes no outbound calls at runtime, with one exception added later at the owner's
  request: feedback she chooses to send goes to the feedback relay
  ([ADR 0005](0005-feedback-is-the-only-outbound-call.md)). Nothing else, and never the data.
- Port 8765 must be free. A conflict is handled with a clear message (see troubleshooting).
- A future "phone on home Wi-Fi" feature would need binding to the LAN and adding a PIN.
