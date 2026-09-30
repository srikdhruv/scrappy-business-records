# Development

## Prerequisites

- [uv](https://docs.astral.sh/uv/getting-started/installation/). It installs the right Python
  itself.
- Node.js 24 (or 22.22+), with npm. CI uses Node 24.
- GNU make. On Windows, use Git Bash or WSL.

## First time

```bash
git clone https://github.com/srikdhruv/scrappy-business-records.git
cd scrappy-business-records
make setup
```

## Everyday commands

| Command | What it does |
|---|---|
| `make help` | List every target |
| `make setup` | `uv sync --locked` in `backend/` and `npm ci` in `frontend/` |
| `make dev` | API with auto-reload on http://127.0.0.1:8765 and the Vite UI on http://localhost:5173 (open this one; it proxies `/api`). Data and backups go in `./.devdata/`. Ctrl-C stops both |
| `make seed` | Fill `./.devdata/` with realistic, fictional demo students and payments (`python -m app.seed`). It refuses if there are students already: to start over, run `make db-reset` first. It only runs with `SCRAPPY_HOME` set, so it can't touch a real install, and `--force` first backs up the database into `$SCRAPPY_HOME/seed-backups/` |
| `make test` | Backend pytest and frontend vitest |
| `make e2e` | Build, then run the Playwright end-to-end tests (`frontend/playwright.config.ts`) against the production server |
| `make lint` | `ruff check` and `ruff format --check` (backend and `scripts/`), ESLint, `prettier --check` and `tsc` |
| `make fmt` | `ruff format`, `ruff check --fix`, Prettier and `eslint --fix` |
| `make gen-api` | Regenerate `frontend/src/api/schema.d.ts` from the backend's OpenAPI. No server needed: it runs `python -m app.openapi_dump` |
| `make build` | Build the UI into `backend/app/static/` |
| `make run` | Serve the production build from :8765 with `python -m app`, as the user's laptop does. Uses `./.devdata/` |
| `make package` | `make build`, then the self-contained bundle zip for this OS in `dist/` (`scripts/build_bundle.py`), which is then unpacked and self-tested. Add `--platform windows-x64` when running the script directly to cross-build the Windows zip (no self-test) |
| `make db-reset` | Delete `./.devdata/` |
| `make clean` | Remove build outputs and caches |

`make e2e` prints a message and stops if the script it runs hasn't been added yet.

API docs: http://127.0.0.1:8765/api/docs while `make dev` is running.

## Project layout

```
backend/
  pyproject.toml, uv.lock, alembic.ini (for the alembic CLI only)
  app/
    __init__.py      __version__ (package metadata, else a VERSION file next to the package)
    __main__.py      `python -m app`: uvicorn on 127.0.0.1:$SCRAPPY_PORT
    main.py          create_app(), lifespan (dirs → [backup hook] → migrate), static SPA serving
    config.py        Paths and ports (platformdirs + SCRAPPY_* env overrides), resolved lazily
    db.py            Engine (foreign keys on), `get_session` / `SessionDep`
    models.py        SQLAlchemy models
    schemas.py       Pydantic request and response models — the API contract
    months.py        "YYYY-MM" <-> first-of-month date helpers
    errors.py        unprocessable() / not_found(): consistent 422 and 404 bodies
    clock.py         get_today() / get_current_month(): the one place the app reads the clock
    seed.py          `python -m app.seed [--force]`: fictional demo data (`make seed`)
    migrate.py       Run Alembic from code (no alembic.ini, no CWD assumptions)
    openapi_dump.py  Print the OpenAPI JSON (used by `make gen-api`)
    services/        ledger.py: pure business rules (dues, statuses, dashboard), no I/O;
                     students.py, payments.py, dashboard.py: the database work routers call;
                     bounds.py (input limits), text.py (case- and accent-insensitive matching)
    routers/         health, students, payments, dashboard
    migrations/      Alembic env.py and versions/ (ships inside the package)
    static/          Built UI (git-ignored; `make build`)
    launcher.py      Desktop-shortcut entry point: health check, start the server, open the browser
    backup.py        Daily / pre-update / pre-migration backups, also `python -m app.backup`
    logs.py          Rotating logs/server.log (set up first thing by `python -m app`)
  tests/             pytest; conftest.py points SCRAPPY_HOME at a temp folder
frontend/src/
  main.tsx, App.tsx  Entry and router
  routes.tsx         Every client route (/, /payments, /students, /students/:id)
  providers.tsx      QueryClient, tooltips, Log payment, toasts
  api/               schema.d.ts (generated), client.ts (openapi-fetch), queries.ts (hooks)
  pages/             Dashboard, Payments, Students, StudentProfile
  components/        App building blocks; layout/ (shell, page header); ui/ (shadcn/ui)
  lib/format.ts      ₹, date and month formatting (the only place that formats them)
  index.css          Theme tokens (CSS variables) and Tailwind setup
  styles/            theme.test.ts checks the text contrast of the theme tokens
  test/              Vitest setup and render helpers
scripts/
  build_bundle.py    `make package`: the self-contained zip, self-tested
  make_icon.py       Draws the app icon (scrappy.ico / scrappy.png) at build time
  install.ps1        Windows installer and updater (`irm ... | iex`)
  install.sh         macOS installer and updater (`curl ... | sh`)
  ci/                Install smoke tests CI runs on Windows and macOS (+ db_probe.py)
```

## Frontend conventions

- **Theme.** Colours are CSS variables in `src/index.css`, exposed as Tailwind colours:
  - `bg-background`: cream.
  - `bg-primary text-primary-foreground`: marigold with dark text. Never put white text on
    marigold.
  - `text-primary-strong`: marigold-coloured text on cream.
  - `bg-accent text-accent-foreground` and `text-terracotta`: terracotta.
  - Status pairs: `bg-paid-soft text-paid`, `bg-partial-soft text-partial`,
    `bg-owed-soft text-owed`, `bg-credit-soft text-credit`.

  `src/styles/theme.test.ts` fails if a pairing drops below WCAG AA contrast.
- **Font.** Nunito, bundled through `@fontsource-variable/nunito`. There's no font CDN because the
  app works offline.
- **Log payment.** Open the app-wide form from anywhere with
  `useLogPayment().openLogPayment({ studentId, forMonth, amountPaise })`.
- **API calls.** Use `api` from `src/api/client.ts` with `unwrap()`, inside TanStack Query hooks
  in `src/api/queries.ts`. Types come from `src/api/schema.d.ts`, e.g.
  `import type { StudentRead } from '@/api/schema'`.
- **shadcn/ui.** Add components with `npx shadcn@latest add <name>` from `frontend/`, then run
  `make fmt`.

## Database migrations

1. Change `backend/app/models.py`.
2. Generate a migration against the dev database:
   `cd backend && SCRAPPY_HOME=../.devdata uv run alembic revision --autogenerate -m "add xyz"`.
3. Read the generated file in `backend/app/migrations/versions/` and fix it if needed. SQLite
   needs `batch_alter_table` for most column changes. Our `env.py` enables `render_as_batch`.
4. `make test`. The test suite migrates a fresh database from zero to head.
   `test_migrations_match_models` fails if the models and the migrations disagree.

The app runs migrations itself at startup through `app.migrate.upgrade_to_head()`. That builds
the Alembic config in code, so it works from any install folder.

**Never edit a released migration.** Add a new one instead.

## Adding an API endpoint

1. Add Pydantic schemas in `schemas.py`, the route in `routers/` (with an `operation_id`), and
   rules in `services/`.
2. Add a test in `backend/tests/`, and add the route to `EXPECTED_OPERATIONS` in
   `tests/test_contract.py`.
3. Run `make gen-api`, commit `frontend/src/api/schema.d.ts`, and use the new types in
   `frontend/src/api/`. CI's `api-contract` job fails if that file is out of date.

## Testing the install

The installers can only really be tested on the OS they're for, so CI does it on every PR.
Look at these jobs when you change anything in `scripts/`, `launcher.py`, `backup.py`, `logs.py`
or `__main__.py`.

**`windows-install`** (on `windows-latest`) builds the UI and the bundle (with its self-test),
then runs `scripts/ci/smoke_install_windows.ps1` in **Windows PowerShell 5.1** with PATH cut
down to Windows' own folders, so no Python or uv can be used by accident. In a temporary
install folder it checks, in order:

1. The one-line form works: the script text piped into `Invoke-Expression`, with the test
   options passed as `SCRAPPY_INSTALL_*` environment variables.
2. The shortcut exists and points at `pythonw.exe -m app.launcher`, with the icon and working
   folder. `data\` doesn't exist yet.
3. `pythonw.exe -m app` (no console at all) answers `/api/health` with the bundle's version, and
   writes `server.log`.
4. Two launchers started at the same moment, from another folder, start exactly one server.
5. A student added straight into `records.db` (the bundled Python's `sqlite3`) survives a
   restart, and today's daily backup exists and contains it.
6. Re-running the installer with the app running (the update path, `-Param` form, launching the
   app) stops the old server, takes a pre-update backup containing the student, keeps the data,
   and leaves no `app.new` or `app.old` behind.
7. With port 8765 held by another program, the launcher exits with code 1 and `server.log` says
   "Something else is using port 8765"; `pythonw -m app` itself logs "error while attempting to
   bind".
8. A failing `| iex` install prints the friendly message and throws, but doesn't end the
   PowerShell session (it never calls `exit`).

**`macos-install`** (on `macos-latest`) does the same for `scripts/install.sh` with
`scripts/ci/smoke_install_mac.sh`, under `env -i PATH=/usr/bin:/bin`. Run it locally with:

```bash
make package
scripts/ci/smoke_install_mac.sh dist/scrappy-records-macos-arm64.zip
```

On a Windows machine, the equivalent is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ci\smoke_install_windows.ps1 -ZipPath dist\scrappy-records-windows-x64.zip
```

It uses port 8765, so stop any running copy of the app first.
