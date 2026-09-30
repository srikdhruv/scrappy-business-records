"""A size limit on request bodies, checked before anything reads or parses them.

`POST /api/import/commit` carries a whole Excel file (base64) as JSON: a body over the limit is
refused with a plain 422 before a byte of it is parsed, and without echoing any of it back.
(`POST /api/import/preview` streams its file and stops at 5 MB itself, in `routers/excel.py`.)
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from fastapi import status
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

COMMIT_BODY_LIMIT = 8 * 1024 * 1024
"""A 5 MB file is about 6.7 MB as base64, plus the owner's choices."""

TOO_BIG = "This is too big to add. Upload a file under 5 MB."


class BodyLimit:
    """ASGI middleware: for `paths`, read the body (up to `limit` bytes) before the app does,
    and refuse a longer one with a 422; the app then gets the body as usual."""

    def __init__(self, app: ASGIApp, paths: Iterable[str], limit: int) -> None:
        self.app = app
        self.paths = frozenset(paths)
        self.limit = limit

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] not in self.paths:
            await self.app(scope, receive, send)
            return
        headers = dict(scope.get("headers") or ())
        length = headers.get(b"content-length", b"")
        if length and (not length.isdigit() or int(length) > self.limit):
            await self._refuse(scope, receive, send)
            return
        chunks: list[bytes] = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body: bytes = message.get("body", b"")
            size += len(body)
            if size > self.limit:
                await self._refuse(scope, receive, send)
                return
            chunks.append(body)
            if not message.get("more_body", False):
                break
        data = b"".join(chunks)
        replayed = False

        async def replay() -> Message:
            nonlocal replayed
            if not replayed:
                replayed = True
                return {"type": "http.request", "body": data, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)

    @staticmethod
    async def _refuse(scope: Scope, receive: Receive, send: Send) -> None:
        detail: list[dict[str, Any]] = [{"loc": ["body"], "msg": TOO_BIG, "type": "value_error"}]
        response = JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, content={"detail": detail}
        )
        await response(scope, receive, send)
