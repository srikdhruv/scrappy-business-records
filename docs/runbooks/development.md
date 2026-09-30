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
| `make seed` | Fill `./.devdata/` with realistic demo students and payments (`python -m app.seed`) |
| `make test` | Backend pytest and frontend vitest |
| `make e2e` | Build, then run the Playwright end-to-end tests (`frontend/playwright.config.ts`) against the production server |
| `make lint` | `ruff check`, `ruff format --check`, ESLint, `prettier --check` and `tsc` |
| `make fmt` | `ruff format`, `ruff check --fix`, Prettier and `eslint --fix` |
| `make gen-api` | Regenerate `frontend/src/api/schema.d.ts` from the backend's OpenAPI. No server needed: it runs `python -m app.openapi_dump` |
| `make build` | Build the UI into `backend/app/static/` |
| `make run` | Serve the production build from :8765 with `python -m app`, as the user's laptop does. Uses `./.devdata/` |
| `make package` | Build the self-contained bundle zip for this OS into `dist/` (`scripts/build_bundle.py`) |
| `make db-reset` | Delete `./.devdata/` |
| `make clean` | Remove build outputs and caches |

`make seed`, `make e2e` and `make package` print a message and stop if the script they run
hasn't been added yet.

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
    migrate.py       Run Alembic from code (no alembic.ini, no CWD assumptions)
    openapi_dump.py  Print the OpenAPI JSON (used by `make gen-api`)
    services/        Pure business rules, e.g. ledger.py (dues, statuses, dashboard)
    routers/         health, students, payments, dashboard
    migrations/      Alembic env.py and versions/ (ships inside the package)
    static/          Built UI (git-ignored; `make build`)
    launcher.py      Desktop-shortcut entry point            (packaging PR)
    backup.py        Backups, also `python -m app.backup`    (packaging PR)
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
scripts/             install.ps1, install.sh, build_bundle.py   (packaging PR)
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

## Testing the Windows install without Windows

CI's `windows-install` job:
1. builds the bundle on `windows-latest`;
2. removes Python from the PATH;
3. runs `scripts/install.ps1 -ZipPath dist\...zip -NoLaunch`;
4. starts the launcher and checks `/api/health`;
5. creates a student, restarts the server, and checks that the student is still there.

Look at that job when you change anything in `scripts/` or `launcher.py`.
