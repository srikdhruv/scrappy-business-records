# Architecture

## In one sentence

The whole app is **one Python process** on the user's laptop. That process serves a JSON API and
a prebuilt React UI on `http://127.0.0.1:8765`, and stores data in a single SQLite file. There is
no Docker, no database server and no separate web server.

```
┌──────────────────────────── the user's laptop ─────────────────────────────┐
│                                                                            │
│  Desktop shortcut ──► pythonw.exe -m app.launcher                          │
│                            │ 1. GET /api/health — is the server up?        │
│                            │ 2. if not: spawn server (detached), wait      │
│                            │ 3. open browser → http://127.0.0.1:8765       │
│                            ▼                                               │
│  ┌──────────── pythonw.exe -m app  (uvicorn, 127.0.0.1:8765) ───────────┐  │
│  │  FastAPI                                                             │  │
│  │   ├─ /api/health, /api/students, /api/payments, /api/dashboard       │  │
│  │   ├─ services/ledger.py  (pure business rules: dues, statuses)       │  │
│  │   ├─ SQLAlchemy ──► sqlite3 (built into Python) ──► data/records.db  │  │
│  │   └─ /  → static/ (built React app, index.html fallback)             │  │
│  │  on startup: make dirs → daily backup → Alembic migrations           │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                            ▲                                               │
│  Browser (Edge/Chrome) ────┘  React UI calls /api/* with fetch             │
└────────────────────────────────────────────────────────────────────────────┘
```

## Components

| Part | Tech | Where |
|---|---|---|
| API | FastAPI + Pydantic v2, served by uvicorn | `backend/app/main.py`, `backend/app/routers/` |
| Business rules | Plain Python functions, no I/O | `backend/app/services/ledger.py` |
| Persistence | SQLAlchemy 2 ORM on SQLite; schema managed by Alembic | `backend/app/models.py`, `backend/app/migrations/` |
| UI | React + TypeScript + Vite + Tailwind + shadcn/ui; TanStack Query and TanStack Table | `frontend/` |
| API types | Generated from FastAPI's OpenAPI schema (`openapi-typescript`) | `frontend/src/api/schema.d.ts` |
| Launcher | Small Python script: health-check, spawn server, open browser | `backend/app/launcher.py` |
| Backups | SQLite online `backup()` API into the user's Documents folder | `backend/app/backup.py` |
| Packaging | Script that assembles a portable Python and the app into a zip | `scripts/build_bundle.py` |
| Installer | PowerShell (Windows) and sh (macOS) | `scripts/install.ps1`, `scripts/install.sh` |

## Where things live on the user's laptop (Windows)

Everything is per-user, so no admin rights are needed.

```
%TEMP%\scrappy-records-windows-x64.zip  ← downloaded by the installer, deleted after extracting
%LOCALAPPDATA%\ScrappyRecords\          (C:\Users\<name>\AppData\Local\ScrappyRecords)
  app\                                  ← the zip's contents; replaced wholesale on update
    python\                             ← portable CPython (python-build-standalone)
      python.exe, pythonw.exe
      Lib\site-packages\                ← fastapi, uvicorn, sqlalchemy, alembic, … preinstalled
    app\                                ← our backend package (+ migrations)
      static\                           ← the built React UI (index.html, assets/)
    Start Scrappy Records.cmd           ← same as the Desktop shortcut, for debugging
    VERSION
  data\
    records.db                          ← ALL user data; installs/updates never touch it
  logs\
    server.log                          ← rotating log, for troubleshooting
Desktop\Scrappy Records.lnk             → app\python\pythonw.exe -m app.launcher
Documents\ScrappyRecords Backups\       ← records-YYYY-MM-DD.db (30 kept) + pre-update copies
```

On macOS the same layout lives under `~/Library/Application Support/ScrappyRecords/`, and the
backups under `~/Documents/ScrappyRecords Backups/`.

Paths are resolved in `backend/app/config.py` using `platformdirs`. Each can be overridden with an
environment variable, which tests and dev mode use:

| Variable | Default (Windows) | Purpose |
|---|---|---|
| `SCRAPPY_HOME` | `%LOCALAPPDATA%\ScrappyRecords` | Root for `data/` and `logs/` |
| `SCRAPPY_DATA_DIR` | `$SCRAPPY_HOME\data` | SQLite file location |
| `SCRAPPY_BACKUP_DIR` | `Documents\ScrappyRecords Backups` | Backups |
| `SCRAPPY_PORT` | `8765` | Server port |

The paths are looked up each time they're needed, not once at import, so tests can change them.
`SCRAPPY_BACKUP_DIR` does **not** follow `SCRAPPY_HOME`: dev mode (`make dev`, `make run`) and the
tests set both, so they never write into a real Documents folder.

## Starting the server

The server is always started the same way: **`python -m app`** (`backend/app/__main__.py`). On
the laptop the launcher runs it with `pythonw.exe`, detached, so no console window appears:

```
app\python\pythonw.exe -m app          (working directory: the app folder)
```

`python -m app` runs uvicorn in-process on `127.0.0.1:$SCRAPPY_PORT` (default 8765) with
`log_config=None` and `use_colors=False`. Under `pythonw`, `sys.stdout` and `sys.stderr` are
`None`, and uvicorn's default logging config would crash on them. So uvicorn doesn't configure
logging at all: its loggers propagate to the root logger, which gets a console handler only
when a console exists. The log file (`logs\server.log`) is added to the root logger by the
packaging PR. Don't start the server as `pythonw -m uvicorn app.main:app`: that uses uvicorn's
default logging and crashes without a console.

## Lifecycle

**Startup.** `app.main`'s lifespan handler (`run_startup_tasks`) runs these steps in order:
1. Create the data, log and backup directories.
2. Take the **daily backup**, if none exists for today.
3. If the database is behind the latest Alembic revision (`app.migrate.needs_upgrade()`), take a
   **pre-migration backup**, then `alembic upgrade head` (`app.migrate.upgrade_to_head()`, which
   builds the Alembic config in code and doesn't depend on the working directory). Migrations
   run with SQLite foreign keys **off**, because rebuilding a table with them on would
   cascade-delete its payments. They run in **one transaction**, and are rolled back if
   `PRAGMA foreign_key_check` finds any broken references afterwards.
4. Serve requests.

The server's version (in `/api/health`) comes from the installed package metadata. If that's
missing, it's read from a `VERSION` file next to the `app` package, as in the bundle layout above.

**Opening the app twice.** The launcher sees `/api/health` answering with
`{"app": "scrappy-records"}` and only opens the browser.

**Port taken by something else.** The health check fails, and binding fails too. The launcher
logs the error and shows a message box pointing to the troubleshooting runbook.

**Shutdown.** The server runs until the user logs off or shuts down. The installer stops any
running server, found by its executable path, before replacing `app\`.

## Why the bundle works on a bare laptop

A stock Windows 10/11 laptop already has PowerShell 5.1, a browser, `Expand-Archive` and
`WScript.Shell`. The installer uses only those. Everything else ships inside the zip:

- The **Python interpreter**: python-build-standalone "install_only" builds are relocatable, so
  they run from any folder without being "installed".
- **Every Python dependency**, installed into that interpreter's `site-packages` in CI. All our
  dependencies are pure Python or ship prebuilt Windows wheels, so no compiler is involved.
- **SQLite**, which is part of Python's standard library.
- The **UI**: static HTML, JS and CSS built by Vite in CI. Node is never needed at runtime.

## Security and privacy

- The server listens on `127.0.0.1` only, so it isn't reachable from the network and triggers no
  firewall prompt.
- There is no authentication, by design: only the logged-in Windows user can reach loopback.
- There are no outbound network calls at runtime and no telemetry.
- The only network access is the installer downloading the release zip from GitHub.

## Development mode

`make dev` runs two processes:
- uvicorn with `--reload` on :8765, using `SCRAPPY_HOME=./.devdata`, so a developer never touches
  real data;
- Vite on :5173, proxying `/api` to :8765.

`make run` serves the production build from :8765 with `python -m app`, exactly as the laptop
does.

See [development runbook](runbooks/development.md).
