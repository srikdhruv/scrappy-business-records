# Contributing

## Workflow

- `main` is always releasable. Whatever is on `main` can be tagged and installed on a real laptop.
- **Features and fixes come in through pull requests.** Branch from `main` (`feat/…`, `fix/…`,
  `chore/…`, `docs/…`) and open a PR. CI must be green before merging. Prefer squash-merge.
- Documentation-only changes may be committed straight to `main` while the project is young.
- Keep PRs focused: one feature or one infra change per PR.

## Before you open a PR

```bash
make fmt    # auto-format backend + frontend
make lint   # ruff, eslint, tsc
make test   # pytest + vitest
```

If you changed the API, run `make gen-api` and commit the regenerated
`frontend/src/api/schema.d.ts`. CI fails if it is out of date.

If you changed the database models, add an Alembic migration (see
[development runbook](docs/runbooks/development.md#database-migrations)). **Never edit a migration
that has been released** — the user's laptop has already run it.

## Principles

1. **The user is non-technical.** Anything they have to do must be a double-click or a single
   pasted line. If a change adds a manual step for them, rethink it.
2. **Their data is sacred.** Installs and updates never touch the data folder. Schema changes go
   through migrations, and a backup is taken first.
3. **Local only.** The server binds to `127.0.0.1`. No telemetry, no external calls at runtime.
4. **Thin MVP.** New ideas go into [future-features.md](docs/product/future-features.md) first.

## Code conventions

- Backend: Python 3.12, type hints everywhere, `ruff` for lint and format. Business rules live in
  `backend/app/services/` as pure functions with unit tests; routers stay thin.
- Money is stored and sent as **integer paise**. Months are `YYYY-MM` strings in the API and
  first-of-month `DATE`s in the database.
- Frontend: TypeScript strict, React function components, TanStack Query for server state, and
  shadcn/ui components. Format money and dates only through `src/lib/format.ts`.
