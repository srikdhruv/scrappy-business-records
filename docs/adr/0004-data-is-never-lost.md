# ADR 0004 — The owner's data is never lost

- **Status:** Accepted
- **Date:** 2026-09-30

## Context

The app keeps a business's fee records on one laptop, for an owner who isn't technical. Losing
or quietly changing what she typed would cost her money and her trust in the app, and she has
no way to notice or repair it herself. The owner's rule: *not losing data, and being easy and
quick to use, are the biggest principles. Whatever changes, updates included, the stored data
must stay as it is.*

v0.1.0 is installed with real data. Each later version meets that data through an update: the
installer swaps in the new app, and the app upgrades the database (a migration) the first time it
starts. Until now, that path was protected by backups and by tests that only ran on data today's
code had written.

## Decision

1. **Updates never touch the data folder.** Installing or updating only replaces the app folder.
   `data\records.db` (and its backups) is never moved, rewritten or deleted by an installer
   ([ADR 0003](0003-distribution-and-install.md)).
2. **Schema changes only add, with defaults.** A migration may add tables, columns (nullable, or
   with a default so existing rows get a value), indexes and constraints. It may not drop or
   rename a table or column that holds the owner's data, change a column's type, make a column
   required, or run SQL that deletes or updates rows. SQLite's "batch" table rebuild (copy every
   row into a new table) is allowed: it keeps every row, runs with foreign keys off, and is
   rolled back if a link breaks.
3. **Any exception needs all three:** the owner's explicit approval, a backup taken first (the
   app always takes one before upgrading), and a migration that preserves the data, proven by a
   test on real-shaped data. The approval is written into the migration as
   `# data-safety: approved by owner — <reason>`.
4. **Computed rules may change; stored entries never get rewritten.** What the app *works out*
   (what's owed, statuses, credit, the dashboard) can change from one version to the next. What
   the owner *entered* (names, phones, notes, fees and when they start, payments, amounts,
   dates, months, methods) stays exactly as saved. A new rule reads the old entries differently;
   it never edits them. Only the owner changes her entries, by editing or deleting them in the
   app.
5. **Every release's data must upgrade intact, and this is tested.** After each release, a
   sample database made by that release's own code is committed
   (`backend/tests/fixtures/releases/<tag>.db`, with a manifest of every row). On every pull
   request, each sample is upgraded with today's code through the app's real startup, and every
   row and value must be unchanged, the backup taken before upgrading must hold the old data,
   the app must show every student, payment and dashboard, and going back down a version and up
   again must keep the data.

## How it is enforced

| Rule | Check | Where |
|---|---|---|
| Migrations only add | *Data safety* CI job scans every migration's `upgrade()` | `scripts/ci/check_migrations_only_add.py` |
| Every release's data upgrades intact | *Data safety* CI job (and the backend jobs, Windows included) | `backend/tests/test_release_upgrades.py` |
| Every release has its sample | The release workflow stops if the previous release has none | `scripts/ci/check_release_fixture.py`, `.github/workflows/release.yml` |
| A table rebuild keeps linked rows | Migration tests | `backend/tests/test_migration_safety.py` |
| Backup before any upgrade; no upgrade without it | Startup code | `backend/app/main.py`, `backend/app/backup.py` |
| One transaction, foreign-key check, rollback | Migration environment | `backend/app/migrations/env.py` |

*Data safety* is a required check: a pull request can't be merged while it fails.

## Alternatives considered

- **Trust backups alone.** Backups make a loss recoverable, but only if someone notices it, and
  the owner can't be expected to. The goal is that nothing is lost in the first place.
- **Test upgrades only from data made by today's code.** That misses exactly the risky case: a
  database written by an older release, with rows today's code would never create.
- **Forbid every non-additive migration outright.** Some day a real fix may need one (for
  example, merging duplicate rows at the owner's request). The approval marker keeps that
  possible, visible in review, and tied to the owner's decision.

## Consequences

- Releasing gains one step: after releasing vX, run `scripts/make_release_fixture.py vX` and
  commit its two files via a PR ([release runbook](../runbooks/release.md)). The next release
  can't be published without it.
- Renaming or reshaping a stored field means adding a new column or table beside the old one,
  which stays as it was. Copying values into a new table (`INSERT ... SELECT`) only adds;
  filling a new column in existing rows is an `UPDATE`, which needs the approval in rule 3. The
  database may keep some unused columns over time; that's the price of never losing an entry.
- A new kind of stored data must be added to `scripts/release_fixture_populate.py`, so the next
  release's sample covers it.
