"""Sends saved feedback to the relay, in the background. One of the app's two outbound calls.

ADR 0005: the app makes no network calls at runtime, except this one, which the owner starts
by sending feedback, and the update check (ADR 0006, `app/updater.py`), which only reads public
release information. Only the `feedback` table's rows go out (see `services/feedback.py`), to
`config.feedback_url()`; when that is empty, nothing is ever sent.

- A daemon thread (`scrappy-feedback`) tries at startup, whenever new feedback is saved
  (`wake()`), and once a minute while anything is waiting.
- It never blocks a request: the dialog saves, then asks for the status.
- Failures back off exponentially (30 s, 1 min, 2 min, … up to an hour, with some jitter):
  offline, a timeout, the relay busy (429) or failing (5xx). A new feedback item, or a restart,
  tries again straight away.
- The relay answering 4xx (other than 408 and 429) means it will never take this item (it
  didn't pass the relay's checks): it's marked `failed` and not retried.
- The relay dedupes by the feedback's id, so sending again after a lost answer files it once.
"""

from __future__ import annotations

import contextlib
import http.client
import ipaddress
import json
import logging
import random
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from app import __version__, config
from app.db import session_factory
from app.services import feedback as service

log = logging.getLogger("scrappy")

TIMEOUT_SECONDS = 20.0
TICK_SECONDS = 60.0
BASE_DELAY = 30.0
MAX_DELAY = 3600.0
_MAX_ANSWER_BYTES = 64 * 1024


@dataclass(frozen=True)
class SendResult:
    outcome: Literal["sent", "retry", "rejected"]
    issue_url: str | None = None
    error: str = ""
    retry_after: float = 0.0


Poster = Callable[[str, dict[str, Any], float], SendResult]


def usable_url(url: str) -> bool:
    """HTTPS anywhere; plain HTTP only to this laptop (the tests' fake relay)."""
    try:
        parts = urllib.parse.urlsplit(url)
    except ValueError:
        return False
    if not parts.hostname:
        return False
    if parts.scheme == "https":
        return True
    if parts.scheme != "http":
        return False
    if parts.hostname == "localhost":
        return True
    try:
        return ipaddress.ip_address(parts.hostname).is_loopback
    except ValueError:
        return False


def ssl_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    # The bundled Python may not find the operating system's certificates (macOS); certifi's
    # list is always there.
    with contextlib.suppress(ImportError, OSError, ssl.SSLError):
        import certifi

        context.load_verify_locations(certifi.where())
    return context


def _retry_after(value: str | None) -> float:
    try:
        return max(0.0, min(float(value or 0), MAX_DELAY))
    except ValueError:
        return 0.0


def post_feedback(url: str, payload: dict[str, Any], timeout: float) -> SendResult:
    """POST one item to the relay and say what happened. Never raises."""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": f"scrappy-records/{__version__}",
        },
    )
    retry_after = 0.0
    try:
        context = ssl_context() if url.startswith("https:") else None
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            status = response.status
            raw = response.read(_MAX_ANSWER_BYTES)
    except urllib.error.HTTPError as e:
        status = e.code
        retry_after = _retry_after(e.headers.get("Retry-After") if e.headers else None)
        try:
            raw = e.read(_MAX_ANSWER_BYTES)
        except (OSError, http.client.HTTPException):
            raw = b""
    except (OSError, http.client.HTTPException, ValueError) as e:
        # Offline, DNS, refused, timed out, TLS: try again later.
        reason = getattr(e, "reason", None) or e
        return SendResult("retry", error=f"Couldn't reach the feedback inbox: {reason}"[:300])
    try:
        answer = json.loads(raw.decode("utf-8")) if raw else {}
    except ValueError:
        answer = {}
    if not isinstance(answer, dict):
        answer = {}
    if 200 <= status < 300:
        issue_url = answer.get("issue_url")
        if isinstance(issue_url, str) and issue_url.startswith("https://"):
            return SendResult("sent", issue_url=issue_url[:500])
        return SendResult("retry", error=f"The feedback inbox gave an odd answer ({status})")
    detail = answer.get("error") or answer.get("status") or ""
    error = f"The feedback inbox answered {status}" + (f": {detail}" if detail else "")
    if status in (408, 429) or status >= 500:
        return SendResult("retry", error=error[:300], retry_after=retry_after)
    return SendResult("rejected", error=error[:300])


class FeedbackSender:
    """Sends what's waiting. `run_once()` does one round (tests call it directly); `start()`
    runs rounds on a thread."""

    def __init__(
        self,
        url: Callable[[], str] = config.feedback_url,
        post: Poster = post_feedback,
        clock: Callable[[], float] = time.monotonic,
        jitter: Callable[[], float] = random.random,
    ) -> None:
        self.url = url
        self.post = post
        self.clock = clock
        self.jitter = jitter
        self.failures = 0  # rounds in a row that couldn't send
        self.paused_until = 0.0
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._round = threading.Lock()
        self._thread: threading.Thread | None = None

    @property
    def enabled(self) -> bool:
        return usable_url(self.url())

    def delay(self, failures: int) -> float:
        """Wait after `failures` failed rounds in a row: 30 s doubling up to an hour, ±20%."""
        base = min(BASE_DELAY * 2 ** max(0, failures - 1), MAX_DELAY)
        return base * (0.8 + 0.4 * self.jitter())

    def wake(self) -> None:
        """New feedback: try now, even while backing off."""
        self.paused_until = 0.0
        self._wake.set()

    def run_once(self) -> int:
        """Send every waiting item, oldest first, stopping at the first that can't go now.
        Returns how many were sent."""
        url = self.url()
        if not usable_url(url):
            return 0
        with self._round:
            if self.clock() < self.paused_until:
                return 0
            sent = 0
            factory = session_factory()
            with factory() as session:
                ids = service.pending_ids(session)
            for feedback_id in ids:
                with factory() as session:
                    row = service.get_feedback(session, feedback_id)
                    if row is None or row.status.value != "pending":
                        continue
                    payload = service.relay_payload(row)
                result = self.post(url, payload, TIMEOUT_SECONDS)
                with factory() as session:
                    if result.outcome == "sent":
                        service.mark_sent(session, feedback_id, result.issue_url or "")
                    else:
                        service.mark_not_sent(
                            session,
                            feedback_id,
                            result.error,
                            permanent=result.outcome == "rejected",
                        )
                if result.outcome == "sent":
                    sent += 1
                    self.failures = 0
                    log.info("Feedback %s sent", feedback_id[:8])
                elif result.outcome == "rejected":
                    log.warning("Feedback %s was turned down: %s", feedback_id[:8], result.error)
                else:
                    self.failures += 1
                    wait = max(self.delay(self.failures), result.retry_after)
                    self.paused_until = self.clock() + wait
                    log.info(
                        "Feedback %s not sent yet (%s); trying again in %d s",
                        feedback_id[:8],
                        result.error,
                        wait,
                    )
                    break
            return sent

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                self.run_once()
            except Exception:
                log.exception("Sending feedback failed")
            self._wake.wait(TICK_SECONDS)
            self._wake.clear()

    def start(self) -> FeedbackSender:
        self._thread = threading.Thread(target=self._run, name="scrappy-feedback", daemon=True)
        self._thread.start()
        return self

    def stop(self, timeout: float = 5.0) -> None:
        self._stop.set()
        self._wake.set()
        if self._thread is not None:
            self._thread.join(timeout)


def start_if_enabled() -> FeedbackSender | None:
    """At startup: the sending thread, if a relay URL is set (else None: nothing is sent)."""
    url = config.feedback_url()
    if not url:
        return None
    if not usable_url(url):
        log.warning("Feedback won't be sent: the relay address isn't https")
        return None
    return FeedbackSender().start()
