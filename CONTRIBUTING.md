# Contributing

## Workflow

- `main` is always releasable. Whatever is on `main` can be tagged and installed on a real laptop.
- **Features and fixes come in through pull requests.** Branch from `main` (`feat/…`, `fix/…`,
  `chore/…`, `docs/…`) and open a PR. CI must be green before merging. Prefer squash-merge.
- `main` is protected: every change, docs included, goes through a pull request.
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

If your PR changes what the user sees or can do, update the
[feature guide](docs/feature-guide.md) in the same PR (see below).

Checklist (the [PR template](.github/pull_request_template.md) repeats it):

- [ ] `make fmt`, `make lint` and `make test` pass.
- [ ] `make gen-api` run and `schema.d.ts` committed, if the API changed.
- [ ] A migration added, if the models changed.
- [ ] **Feature guide (`docs/feature-guide.md`) updated**, with new pictures if a screen changed
      noticeably, or this PR doesn't change what the user sees.

## Keep the feature guide up to date

[`docs/feature-guide.md`](docs/feature-guide.md) describes every screen as it really is. It
must never describe something that isn't built, or miss something that is.

- **Rule:** any PR that changes what the user can see or do (screens, wording, flows, or API
  behaviour that the UI shows) **must** update the feature guide in the same PR. If a screen
  changed noticeably, retake its pictures with `make guide-screenshots` and commit the ones
  that changed.
- **CI enforces it.** The *Feature guide* check fails when a PR changes `frontend/src/`
  (except tests, `*.test.*` files and the mock API), `backend/app/routers/`,
  `backend/app/services/` or `backend/app/schemas.py`, and doesn't change
  `docs/feature-guide.md`.
- **Only if the user really sees no difference** (a refactor, a speed-up, a test helper), add
  the **`no-guide-change`** label to the PR instead. The check re-runs when labels change.
- Check it locally: `python3 scripts/ci/check_feature_guide.py --base origin/main`.

## Principles

1. **The user is non-technical.** Anything they have to do must be a double-click or a single
   pasted line. If a change adds a manual step for them, rethink it.
2. **Their data is sacred.** Installs and updates never touch the data folder. Schema changes go
   through migrations, and a backup is taken first.
3. **Local only.** The server binds to `127.0.0.1`. No telemetry, no external calls at runtime.
4. **Thin MVP.** New ideas go into [future-features.md](docs/product/future-features.md) first.

## Code conventions

- Backend: Python 3.12, type hints everywhere, `ruff` for lint and format. Business rules live in
  `backend/app/services/ledger.py` as pure functions with unit tests. The other modules in
  `services/` do the database work, and routers stay thin. Never read the clock directly: use
  `app.clock.TodayDep` or `CurrentMonthDep`.
- Money is stored and sent as **integer paise**. Months are `YYYY-MM` strings in the API and
  first-of-month `DATE`s in the database.
- Frontend: TypeScript strict, React function components, TanStack Query for server state, and
  shadcn/ui components. Format money and dates only through `src/lib/format.ts`.
