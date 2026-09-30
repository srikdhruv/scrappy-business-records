"""Error helpers so every error the UI sees has a predictable shape.

- 404 and similar: `HTTPException(404, "No student with id 3")` → `{"detail": "..."}`.
- 422: always FastAPI's validation shape, `{"detail": [{"loc": [...], "msg": "...", "type": ...}]}`,
  including business rules checked in routers. Use `unprocessable()` for those:

      raise unprocessable("left_month cannot be before joined_month", field="left_month")
"""

from __future__ import annotations

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
    """`value` with any character that can't be written as UTF-8 (e.g. a lone "\\ud800" sent
    in JSON) replaced by "?", so an error that echoes the bad input can still be sent."""
    if isinstance(value, str):
        return value.encode("utf-8", "replace").decode("utf-8")
    if isinstance(value, list | tuple):
        return [_printable(v) for v in value]
    if isinstance(value, dict):
        return {_printable(k): _printable(v) for k, v in value.items()}  # type: ignore[misc]
    return value


async def validation_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    """FastAPI's own 422 body (`{"detail": exc.errors()}`), made safe to encode."""
    assert isinstance(exc, RequestValidationError)
    detail = _printable(jsonable_encoder(exc.errors()))
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, content={"detail": detail}
    )
