"""The FastAPI app: JSON API under `/api`, and the built React UI at `/`.

Startup order (see docs/architecture.md, "Lifecycle"):
1. create the data, log and backup folders;
2. daily backup, and a pre-migration backup if the schema is behind  <- packaging PR
3. `alembic upgrade head`;
4. serve requests.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse

from app import __version__, config, errors, migrate
from app.db import dispose_engines
from app.routers import api_router

log = logging.getLogger("scrappy")

# Hashed build assets never change, so browsers may cache them forever. index.html must always
# be re-checked, so an updated app shows up on the next page load.
_IMMUTABLE = "public, max-age=31536000, immutable"
_NO_CACHE = "no-cache"


def run_startup_tasks() -> None:
    config.ensure_dirs()

    # --- BACKUP HOOK (packaging PR) -------------------------------------------------------
    # Take the daily backup here, and a pre-migration backup when `migrate.needs_upgrade()`
    # is True, BEFORE the upgrade below. See docs/architecture.md "Lifecycle" and ADR 0002.
    # ---------------------------------------------------------------------------------------

    migrate.upgrade_to_head()
    log.info("Database ready at %s", config.db_path())


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    run_startup_tasks()
    yield
    dispose_engines()


def _add_spa(app: FastAPI, static_dir: Path) -> None:
    """Serve the built UI from `static_dir`, falling back to index.html for client routes."""
    root = static_dir.resolve()
    index = root / "index.html"

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def spa(full_path: str) -> FileResponse:
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Not Found")
        if not index.is_file():
            raise HTTPException(
                status.HTTP_404_NOT_FOUND, "The UI has not been built. Run `make build`."
            )
        if full_path:
            candidate = (root / full_path).resolve()
            if candidate.is_relative_to(root) and candidate.is_file():
                cache = _IMMUTABLE if full_path.startswith("assets/") else _NO_CACHE
                return FileResponse(candidate, headers={"Cache-Control": cache})
            # A missing build file (e.g. an old JS chunk after an update) must be a real 404.
            # Answering with index.html would make the browser run HTML as JS: a blank page.
            if full_path.startswith("assets/"):
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Not Found")
        return FileResponse(index, headers={"Cache-Control": _NO_CACHE})


def create_app(static_dir: Path | None = None) -> FastAPI:
    app = FastAPI(
        title="Scrappy Records",
        version=__version__,
        openapi_url="/api/openapi.json",
        docs_url="/api/docs",
        redoc_url=None,
        lifespan=lifespan,
        # One schema per model in the OpenAPI output, so generated TypeScript names match ours.
        separate_input_output_schemas=False,
    )
    app.add_exception_handler(RequestValidationError, errors.validation_error_handler)
    app.include_router(api_router)
    _add_spa(app, static_dir or config.static_dir())
    return app


app = create_app()
