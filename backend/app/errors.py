"""Error helpers so every error the UI sees has a predictable shape.

- 404 and similar: `HTTPException(404, "No student with id 3")` → `{"detail": "..."}`.
- 422: always FastAPI's validation shape, `{"detail": [{"loc": [...], "msg": "...", "type": ...}]}`,
  including business rules checked in routers. Use `unprocessable()` for those:

      raise unprocessable("left_month cannot be before joined_month", field="left_month")
"""

from __future__ import annotations

import math

from fastapi import HTTPException, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


def unprocessable(msg: str, field: str | None = None, location: str = "body") -> HTTPException:
    """A 422 whose body matches FastAPI's `HTTPValidationError` schema."""
    loc: list[str] = [location, field] if field else [location]
    return HTTPException(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail=[{"loc": loc, "msg": msg, "type": "value_error"}],
    )


def not_found(what: str, id_: int) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"No {what} with id {id_}")


def _printable(value: object) -> object:
    """`value` made JSON-safe, so an error that echoes the bad input can still be sent:
    characters that can't be written as UTF-8 (e.g. a lone "\\ud800") become "?", and NaN,
    Infinity or an overflowing number like 1e400 become strings."""
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    if isinstance(value, str):
        return value.encode("utf-8", "replace").decode("utf-8")
    if isinstance(value, list | tuple):
        return [_printable(v) for v in value]
    if isinstance(value, dict):
        return {_printable(k): _printable(v) for k, v in value.items()}  # type: ignore[misc]
    return value


CLASH_MESSAGE = (
    "That change clashed with another one saved at the same moment. Reload the page and check."
)


async def integrity_error_handler(_request: Request, _exc: Exception) -> JSONResponse:
    """A database rule (a unique month, a student that no longer exists) refused a write that
    raced another request. Say so plainly as a 409, never a 500."""
    return JSONResponse(status_code=status.HTTP_409_CONFLICT, content={"detail": CLASH_MESSAGE})


QUIET_PATHS = ("/api/import/commit",)
"""Where a 422 never echoes what was sent (a whole file, base64-encoded)."""


async def validation_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """FastAPI's own 422 body (`{"detail": exc.errors()}`), made safe to encode."""
    assert isinstance(exc, RequestValidationError)
    errors = exc.errors()
    if request.url.path in QUIET_PATHS:
        errors = [{k: v for k, v in e.items() if k in ("loc", "msg", "type")} for e in errors]
    detail = _printable(jsonable_encoder(errors))
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, content={"detail": detail}
    )
