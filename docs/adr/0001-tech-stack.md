# ADR 0001 — Tech stack: Python (FastAPI + SQLite) backend, React frontend

- **Status:** Accepted
- **Date:** 2026-09-29

## Context

We need a presentable UI (the most important quality) and a small API over a local database.
The app must also be packaged for a Windows laptop with nothing installed. Future work includes
parsing messy bank-statement spreadsheets and, possibly, browser automation.

## Decision

**Backend:**
- Python 3.12 and FastAPI, with Pydantic v2 for schemas.
- SQLAlchemy 2 for the ORM, with Alembic for migrations.
- SQLite as the database.
- `uv` for dependency management in development.

**Frontend:**
- React, TypeScript, Vite and Tailwind CSS, with shadcn/ui components.
- TanStack Query for server state and TanStack Table for sortable tables.
- API types generated from the backend's OpenAPI schema.

## Alternatives considered

- **All TypeScript (Node + built-in SQLite).**
  - For: one language.
  - Against: bundling a Node runtime is similar effort, and the spreadsheet and fuzzy-matching
    ecosystem is weaker for our future bank-import work.
- **Desktop shell (Tauri or Electron).**
  - For: a native installer and window.
  - Against: heavier CI (code-signing, Rust or Electron toolchains) for little MVP benefit.
  - This may be revisited for a signed installer later (future-features §9).
- **Server-rendered HTML (HTMX + Jinja).**
  - For: no frontend build.
  - Against: harder to reach the polished, app-like UI that matters most here.

## Consequences

- There are two toolchains in development (uv and npm). Only CI builds the frontend; users
  never need Node.
- SQLite means a single file, which makes backup and restore simple. It is plenty for one user.
- Pandas, openpyxl and rapidfuzz are available when bank import arrives.
