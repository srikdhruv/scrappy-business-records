# Development

## Prerequisites

- [uv](https://docs.astral.sh/uv/getting-started/installation/). It installs the right Python
  itself.
- Node.js 20 or newer, with npm.
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
| `make dev` | API with auto-reload on http://127.0.0.1:8765 and the Vite UI on http://localhost:5173 (open this one). Data goes in `./.devdata/` |
| `make seed` | Fill `./.devdata/` with realistic demo students and payments |
| `make test` | Backend pytest and frontend vitest |
| `make e2e` | Build, then run the Playwright end-to-end tests against the production server |
| `make lint` / `make fmt` | Lint and type-check, or auto-format |
| `make gen-api` | Regenerate `frontend/src/api/schema.d.ts` from the backend's OpenAPI |
| `make build` | Build the UI into `backend/app/static/` |
| `make run` | Serve the production build from :8765, as the user's laptop does |
| `make package` | Build the self-contained bundle zip for this OS into `dist/` |
| `make db-reset` | Delete `./.devdata/` |
| `make clean` | Remove build outputs and caches |

API docs: http://127.0.0.1:8765/api/docs while `make dev` is running.

## Project layout

```
backend/app/
  main.py          FastAPI app, lifespan (dirs → backup → migrate), static SPA serving
  config.py        Paths and ports (platformdirs + SCRAPPY_* env overrides)
  db.py            Engine and session
  models.py        SQLAlchemy models
  schemas.py       Pydantic request and response models
  services/ledger.py   Pure business rules (dues, statuses, dashboard)
  routers/         health, students, payments, dashboard
  migrations/      Alembic
  launcher.py      Desktop-shortcut entry point
  backup.py        Backups (also runnable as `python -m app.backup`)
frontend/src/
  api/             Generated types and the fetch client
  pages/           Dashboard, Payments, Students, StudentProfile
  components/      UI building blocks (shadcn/ui in components/ui)
  lib/format.ts    ₹, date and month formatting
scripts/           install.ps1, install.sh, build_bundle.py
```

## Database migrations

1. Change `backend/app/models.py`.
2. Generate a migration:
   `cd backend && uv run alembic revision --autogenerate -m "add xyz"`.
3. Read the generated file in `backend/app/migrations/versions/` and fix it if needed. SQLite
   needs `batch_alter_table` for most column changes. Our `env.py` enables `render_as_batch`.
4. `make test`. The test suite migrates a fresh database from zero to head.

**Never edit a released migration.** Add a new one instead.

## Adding an API endpoint

1. Add Pydantic schemas in `schemas.py`, the route in `routers/`, and rules in `services/`.
2. Add a test in `backend/tests/`.
3. Run `make gen-api` and use the new types in `frontend/src/api/`.

## Testing the Windows install without Windows

CI's `windows-install` job:
1. builds the bundle on `windows-latest`;
2. removes Python from the PATH;
3. runs `scripts/install.ps1 -ZipPath dist\...zip -NoLaunch`;
4. starts the launcher and checks `/api/health`;
5. creates a student, restarts the server, and checks that the student is still there.

Look at that job when you change anything in `scripts/` or `launcher.py`.
