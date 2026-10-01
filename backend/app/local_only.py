"""Only this laptop's own pages may use the app: a check on every request.

The server listens on 127.0.0.1 only, so nothing on the network can reach it. But a web page
open in the same browser can still try:

- **DNS rebinding.** A website whose name is made to point at 127.0.0.1 could read the API as
  if it were its own (`Host: evil.example:8765`). Every request (API and the UI's files) must
  name the app itself in `Host`: `127.0.0.1:<port>` or `localhost:<port>`, where `<port>` is
  the port this server is listening on. Anything else gets a plain 403.
- **Cross-site requests.** A page elsewhere can make the browser *send* a form or a request
  here (it just can't read the answer). Every request that changes something (anything but
  GET and HEAD under `/api/`) is refused if the browser says it came from another site: an
  `Origin` that isn't the app, or a `Sec-Fetch-Site` other than `same-origin` / `none`.
  Programs that aren't browsers (the launcher, the installers, tests) send neither header.

The update endpoints add their own stricter checks on top (routers/update.py).
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

SAFE_METHODS = frozenset({"GET", "HEAD"})
NOT_HERE = "Only Scrappy Records itself, on this laptop's address, can do this."


def app_hosts(scope: Scope) -> set[str]:
    """`Host` values that mean this app: 127.0.0.1 or localhost, on the port we listen on."""
    server = scope.get("server") or ("", None)
    port = server[1] if len(server) > 1 else None
    if not port:
        return set()
    return {f"127.0.0.1:{port}", f"localhost:{port}"}


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers") or ():
        if key.lower() == name:
            return value.decode("latin-1").strip()
    return None


def refusal(scope: Scope) -> str | None:
    """Why this request must be refused, or None if it's fine."""
    hosts = app_hosts(scope)
    host = (_header(scope, b"host") or "").lower()
    if host not in hosts:
        return "host"
    method = str(scope.get("method", "GET")).upper()
    path = str(scope.get("path", ""))
    if method in SAFE_METHODS or not (path == "/api" or path.startswith("/api/")):
        return None
    origin = _header(scope, b"origin")
    if origin is not None and origin.lower() not in {f"http://{h}" for h in hosts}:
        return "origin"
    fetch_site = _header(scope, b"sec-fetch-site")
    if fetch_site is not None and fetch_site.lower() not in ("same-origin", "none"):
        return "fetch-site"
    return None


class LocalOnlyMiddleware:
    """ASGI middleware: answers 403 to anything `refusal()` refuses."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or refusal(scope) is None:
            await self.app(scope, receive, send)
            return
        body = json.dumps({"detail": NOT_HERE}).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
