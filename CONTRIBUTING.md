# Contributing

## Workflow

- `main` is always releasable. Whatever is on `main` can be tagged and installed on a real laptop.
- **Features and fixes come in through pull requests.** Branch from `main` (`feat/…`, `fix/…`,
  `chore/…`, `docs/…`).
- `main` is protected: every change, docs included, goes through a pull request, and **every CI
  check is required** to merge, including *Feature guide updated*.
- Keep PRs focused: one feature or one infra change per PR.

### How a PR goes in

1. Open it as a **draft**, with the body from the
   [PR template](.github/pull_request_template.md) (plain-words summary first, and screenshots of
   the real app for anything the user sees).
2. An **adversarial review** scrutinises it; fix what it finds and push new commits.
3. Get **all CI checks green**.
4. **Mark it ready** for review.
5. The **owner reads the body and merges** it. Nobody else merges.

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

Checklist (the [PR template](.github/pull_request_template.md) has the same one):

- [ ] `make fmt`, `make lint` and `make test` pass
- [ ] `make gen-api` run and `frontend/src/api/schema.d.ts` committed, if the API changed
- [ ] A migration added, if the database models changed (never edit a released one)
- [ ] Feature guide (`docs/feature-guide.md`) updated, with new pictures if a screen changed
      noticeably, or this PR doesn't change what the user sees
- [ ] Other docs updated if they no longer match (`daily-use.md`, the PRD, the data model)
- [ ] No personal information: demo data only, with made-up names and numbers

## Keep the feature guide up to date

[`docs/feature-guide.md`](docs/feature-guide.md) describes every screen as it really is. It
must never describe something that isn't built, or miss something that is.

- **Rule:** any PR that changes what the user can see or do (screens, wording, flows, or API
  behaviour that the UI shows) **must** update the feature guide in the same PR. If a screen
  changed noticeably, retake its pictures with `make guide-screenshots` and commit the ones
  that changed.
- **CI enforces it.** The required *Feature guide updated* check fails when a PR changes any of
  these and doesn't change `docs/feature-guide.md`:
  - `frontend/src/` (except tests, `*.test.*` files and the mock API), `frontend/index.html`,
    `frontend/public/`;
  - `backend/app/routers/`, `backend/app/services/`, `backend/app/schemas.py`;
  - `backend/app/main.py`, `launcher.py`, `backup.py`, `clock.py`, `months.py`;
  - `scripts/install.ps1`, `scripts/install.sh`.

  A PR whose only such change is a regenerated `frontend/src/api/schema.d.ts` or files in
  `frontend/src/components/ui/` passes. The list lives in `scripts/ci/check_feature_guide.py`.
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
