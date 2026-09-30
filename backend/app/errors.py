"""Error helpers so every error the UI sees has a predictable shape.

- 404 and similar: `HTTPException(404, "No student with id 3")` → `{"detail": "..."}`.
- 422: always FastAPI's validation shape, `{"detail": [{"loc": [...], "msg": "...", "type": ...}]}`,
  including business rules checked in routers. Use `unprocessable()` for those:

      raise unprocessable("left_month cannot be before joined_month", field="left_month")
"""

from __future__ import annotations

from fastapi import HTTPException, status


def unprocessable(msg: str, field: str | None = None, location: str = "body") -> HTTPException:
    """A 422 whose body matches FastAPI's `HTTPValidationError` schema."""
    loc: list[str] = [location, field] if field else [location]
    return HTTPException(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail=[{"loc": loc, "msg": msg, "type": "value_error"}],
    )


def not_found(what: str, id_: int) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"No {what} with id {id_}")
