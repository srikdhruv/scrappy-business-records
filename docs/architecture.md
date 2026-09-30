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
| Launcher | Small Python script: health-check, spawn server, open browser, explain failures | `backend/app/launcher.py` |
| Backups | SQLite online `backup()` API into the user's Documents folder | `backend/app/backup.py` |
| Logging | Rotating `logs/server.log`, set up before anything else | `backend/app/logs.py` |
| Server lifetime | One server per database (lock), polite stop, daily backup while running | `backend/app/lifetime.py` |
| Packaging | Script that assembles a portable Python and the app into a zip, then self-tests it | `scripts/build_bundle.py` |
| App icon | Marigold circle with a ₹, drawn at build time in the theme colours | `scripts/make_icon.py` |
| Installer | PowerShell (Windows) and sh (macOS) | `scripts/install.ps1`, `scripts/install.sh` |
| Install checks | End-to-end install tests CI runs on each OS | `scripts/ci/` |

## Where things live on the user's laptop (Windows)

Everything is per-user, so no admin rights are needed.

```
%TEMP%\scrappy-records-windows-x64.zip  ← downloaded by the installer, deleted after extracting
%LOCALAPPDATA%\ScrappyRecords\          (C:\Users\<name>\AppData\Local\ScrappyRecords)
  app\                                  ← the zip's contents; replaced wholesale on update
    python\                             ← portable CPython 3.12 (python-build-standalone)
      python.exe, pythonw.exe
      Lib\site-packages\                ← fastapi, uvicorn, sqlalchemy, alembic, … preinstalled
        scrappy-records.pth             ← puts app\ on sys.path, so `-m app…` works from any folder
    app\                                ← our backend package (+ migrations)
      static\                           ← the built React UI (index.html, assets/)
    Start Scrappy Records.cmd           ← same as the Desktop shortcut, but shows errors in a console
    scrappy.ico, scrappy.png            ← the app icon (shortcut; macOS .app)
    VERSION
  app.new\, app.old\                    ← only exist for a moment during an update
  data\
    records.db                          ← ALL user data; installs/updates never touch it
    server.lock                         ← held by the running server: one server per database
    backups\                            ← only if the Documents backup folder can't be written
  stop-server.request                   ← written by the installer to ask the server to stop
  logs\
    server.log (+ .1, .2)               ← rotating log (about 1 MB each), for troubleshooting
    server-console.log                  ← the server's raw output; started fresh at each start
    launcher.lock                       ← stops two launchers starting two servers
Desktop\Scrappy Records.lnk             → app\python\pythonw.exe -m app.launcher (icon: scrappy.ico)
Documents\ScrappyRecords Backups\       ← records-YYYY-MM-DD.db (30 kept) + pre-update copies
```

On macOS the same layout lives under `~/Library/Application Support/ScrappyRecords/`, with
`python/bin/python3` instead of `python\pythonw.exe`. The backups go to
`~/Documents/ScrappyRecords Backups/`, and the launcher is `~/Applications/Scrappy Records.app`, a
small AppleScript app that runs `python3 -m app.launcher`.

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
when a console exists. Before anything else, `python -m app` adds the rotating log file
(`logs\server.log`, about 1 MB × 3 files, `app/logs.py`) to the root logger, and logs uncaught
exceptions there too (`sys.excepthook`). Under `pythonw` that file is the only place a startup
failure (port in use, a migration error) can be seen.

Then, still before uvicorn starts (so before any backup or migration), it takes the **server
lock**: an exclusive lock on `data\server.lock`, held until the process exits (the OS releases
it if the process dies). If another server already holds it, this one logs "already running or
starting" and exits with code 0. That makes "two servers backing up and migrating the same
database at once" impossible, even if a launcher gave up on a very slow first start and the user
double-clicked again.

While it runs, a housekeeping thread (`app/lifetime.py`) checks once a second:
- for `stop-server.request` in `$SCRAPPY_HOME`, which the installer writes to ask for a polite
  stop. The server then finishes its requests and exits normally, instead of being killed
  mid-write. A request left over from before the server started is ignored.
- whether the date has changed (and, hourly, whether today's backup is still missing). If so,
  it takes the **daily backup**, so a laptop that only ever sleeps still gets one each day.

Don't start the server as
`pythonw -m uvicorn app.main:app`: that uses uvicorn's default logging and crashes without a
console.

## The launcher

The Desktop shortcut runs `pythonw.exe -m app.launcher` (`backend/app/launcher.py`):

1. **Is it already running?** It first checks whether it could bind `127.0.0.1:$SCRAPPY_PORT`
   itself (a quick test: on Windows a refused connection takes about 2 s). If the port is busy,
   it asks `GET /api/health`. An answer with `"app": "scrappy-records"` means the server is up.
   If not, it checks the **server lock**: if it's held, our own server exists but isn't
   answering yet (starting up, or stuck), so it waits for that one instead of starting another.
2. **If not, start it**: `pythonw.exe -m app`, fully detached (Windows: `DETACHED_PROCESS`,
   `CREATE_NEW_PROCESS_GROUP` and `CREATE_NO_WINDOW`; macOS: a new session), with the bundle
   folder as its working directory and its raw output in `logs\server-console.log`. It keeps
   running after the launcher exits.
3. **Wait** for `/api/health`, polling for up to 20 s, or up to 60 s while a server is visibly
   still starting (our process is running, or the server lock is held). A server that exits
   with code 0 found another one holding the lock, so the launcher waits for that one.
4. **Open the browser** at `http://127.0.0.1:8765/` (`webbrowser`).
5. **On failure**, it shows a plain-language native message box (`MessageBoxW` on Windows,
   `osascript` on macOS) that names the log file, and exits with code 1. The messages tell apart
   another program on the port ("restart the laptop"), our own server holding the port without
   answering ("seems to be stuck, restart the laptop") and a slow start ("still starting, wait a
   minute, then double-click again"). `server.lock` holds the time the server started: if our
   server has been starting for more than 3 minutes without opening the port, that is "stuck"
   too, not "still starting".

Steps 1–3 hold a lock file (`logs\launcher.lock`), so double-clicking the shortcut twice starts
one server: the second launcher waits, sees the first one's server and just opens the browser.

For tests and CI: `SCRAPPY_NO_BROWSER=1` skips the browser, and `SCRAPPY_NO_DIALOG=1` prints
messages instead of showing a box, which would otherwise wait for a click.

## Lifecycle

**Startup.** `app.main`'s lifespan handler (`run_startup_tasks`) runs these steps in order:
1. Create the data, log and backup directories. (If the backup folder can't be created, for
   example because macOS denied access to Documents, startup carries on, and backups go to
   `data/backups` instead.)
2. Take the **daily backup** (`records-YYYY-MM-DD.db`), if none exists for today, and delete all
   but the 30 newest dailies (newest by when they were written, never the one just taken, so a
   laptop clock set to the wrong year can't make it delete today's copy). There's nothing to back up on the very first start. A failed daily
   backup is logged and the app still opens. (The running server takes later dailies itself,
   see "Starting the server".)
3. If a database exists and is behind the latest Alembic revision (`app.migrate.needs_upgrade()`),
   take a **pre-migration backup**. If that backup fails, startup stops: we never upgrade a
   database we couldn't copy first. Then `alembic upgrade head`
   (`app.migrate.upgrade_to_head()`, which
   builds the Alembic config in code and doesn't depend on the working directory). Migrations
   run with SQLite foreign keys **off**, because rebuilding a table with them on would
   cascade-delete its payments. They run in **one transaction**, and are rolled back if
   `PRAGMA foreign_key_check` finds any broken references afterwards.
4. Serve requests.

The server's version (in `/api/health`) comes from the installed package metadata. If that's
missing, it's read from a `VERSION` file next to the `app` package, as in the bundle layout above.

**Opening the app twice.** The launcher sees `/api/health` answering with
`{"app": "scrappy-records"}` and only opens the browser.

**Port taken by something else.** The port is busy, but `/api/health` doesn't answer as ours. The
launcher doesn't start a server; it logs "Something else is using port 8765" to `server.log` and
shows a message box saying so. (If the server is started by hand anyway, uvicorn can't bind, and
logs "error while attempting to bind" to `server.log` before exiting.)

**Our server stuck on the port.** The port is busy, `/api/health` doesn't answer, and the
server lock is held: it's our own server. The launcher waits up to 60 s, then says "Scrappy
Records seems to be stuck. Restart the laptop."

**Shutdown.** The server runs until the user logs off or shuts down. Before replacing `app\`, the
installer finds any running server by its executable path (`Win32_Process`), asks it to stop
(`stop-server.request`), and only force-stops what is still running after 10 seconds.

**Backups** use SQLite's online backup API (`sqlite3.Connection.backup`) into a temporary file
that is renamed when complete. The live database is opened read-write (never created), so a hot
`records.db-journal` left by a crash or a forced stop is rolled back first; a read-only
connection would fail with "attempt to write a readonly database". If the backup folder can't be
written (an `OSError` *or* a `sqlite3.Error` such as "unable to open database file", as with
Controlled Folder Access or a OneDrive lock), the copy goes to `data\backups`. See
[backups](runbooks/backup-and-restore.md).

## Why the bundle works on a bare laptop

A stock Windows 10/11 laptop already has PowerShell 5.1 (with .NET's zip support), a browser
and `WScript.Shell`. The installer uses only those. Everything else ships inside the zip:

- The **Python interpreter**: python-build-standalone "install_only" builds are relocatable, so
  they run from any folder without being "installed".
- **Every Python dependency**, installed into that interpreter's `site-packages` in CI. All our
  dependencies are pure Python or ship prebuilt Windows wheels, so no compiler is involved.
- **SQLite**, which is part of Python's standard library.
- The **UI**: static HTML, JS and CSS built by Vite in CI. Node is never needed at runtime.

How `scripts/build_bundle.py` (`make package`) builds it:

1. Downloads the pinned python-build-standalone CPython 3.12 for the platform, checks its SHA-256
   against the value in the script, and caches it in `~/.cache/scrappy-bundle`.
2. Removes parts the app never uses (tests, IDLE, Tcl/Tk, pip, headers, Windows debug symbols).
3. Installs the runtime dependencies from `uv export --frozen --no-dev --no-emit-project` with
   `uv pip install --python <bundled python> --only-binary :all: --require-hashes`.
4. Copies `backend/app/` (with migrations and the built `static/`; it stops if the UI isn't
   built), and adds `VERSION`, the icon, `scrappy-records.pth` and `Start Scrappy Records.cmd`
   (`.command` on macOS).
5. Pre-compiles every `.py` file ("unchecked-hash" `.pyc` files), so the first start on a slow
   laptop is quicker.
6. Zips it as `dist/scrappy-records-<platform>.zip` (`windows-x64` or `macos-arm64`, no version
   in the name): about 25 MB for Windows and 32 MB for macOS.
7. **Self-test**: unzips the result into a temporary folder and, with a clean environment (no
   virtualenv, PATH cut down to the system's own folders), checks that `import app` finds the
   bundle's copy from another folder, then starts `python -m app` and checks `/api/health` and
   the UI.

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
