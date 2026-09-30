"""Errors raised by the services, already shaped as FastAPI responses.

- `NotFound` answers 404 with `{"detail": "No student with id 7"}`.
- `invalid()` answers 422 in the same shape as FastAPI's own validation errors, so the UI
  handles a rule broken inside a service exactly like a malformed request.
"""

from __future__ import annotations

from fastapi import HTTPException, status
from fastapi.exceptions import RequestValidationError


class NotFound(HTTPException):
    def __init__(self, what: str, id_: int) -> None:
        super().__init__(status.HTTP_404_NOT_FOUND, f"No {what} with id {id_}")


def invalid(field: str, message: str, value: object = None) -> RequestValidationError:
    """A 422 about one field of the request body."""
    return RequestValidationError(
        [
            {
                "type": "value_error",
                "loc": ("body", field),
                "msg": f"Value error, {message}",
                "input": value,
            }
        ]
    )
