"""What feedback carries besides the owner's message: facts about this copy of the app.

Everything here is about the app and the laptop, never the owner's records. Nothing reads the
database's students, fees or payments, and the database file, its backups and exports are never
attached (`tests/test_feedback.py` checks that no stored record shows up in what is sent).

- `install_id()`: a random ID for this copy of the app, made once and kept in the data folder,
  so feedback from the same laptop can be grouped. It says nothing about who uses it.
- `log_tail()`: the last warnings, errors and app notes in `server.log`, with the laptop
  user's name and home folder hidden (`redact`), and quoted values and the values a database
  error prints (`[parameters: ...]`) removed.
- `server_environment()`: app version, build ID, operating system, Python, database revision.
"""

from __future__ import annotations

import datetime as dt
import logging
import os
import platform
import re
import uuid
from pathlib import Path

from app import __version__, build_id, config, logs

log = logging.getLogger("scrappy")

LOG_TAIL_LINES = 200
LOG_TAIL_MAX_CHARS = 64 * 1024
LOG_LINE_MAX_CHARS = 500
_READ_BYTES = 256 * 1024  # enough for 200 long lines, without reading a whole 1 MB log
_SCAN_LINES = 2000  # how far back to look for lines worth sending


# --------------------------------------------------------------------------- install ID


def install_id() -> str:
    """This copy's random ID (a UUID), made the first time it's needed. Never raises: if the
    data folder can't be written, a fresh ID is returned (and logged) without being kept."""
    path = config.install_id_file()
    try:
        existing = path.read_text(encoding="ascii").strip()
        return str(uuid.UUID(existing))
    except (OSError, ValueError, UnicodeDecodeError):
        pass
    new = str(uuid.uuid4())
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        tmp.write_text(new + "\n", encoding="ascii")
        os.replace(tmp, path)
    except OSError:
        log.warning("Couldn't save the install ID in %s", redact(str(path.parent)))
    return new


# --------------------------------------------------------------------------- log tail

_SEP = r"(?:\\+|/+|%5C|%2F)"
r"""A path separator as it shows up in text: \, \\ (escaped, as in a Python repr), /, or
URL-encoded."""
_USER_DIR = re.compile(
    rf"(?P<lead>{_SEP}|^|(?<=[\s'\"(=:]))(?P<dir>Users|home|Documents and Settings)"
    rf"(?P<sep>{_SEP})(?P<name>(?:[^\\/%'\"<>|:*?,;()\r\n]|%20)+)",
    re.IGNORECASE,
)
r"""`C:\Users\<name>`, `/Users/<name>`, `/home/<name>`, 8.3 short names (`ANANYA~1`) too:
whoever the user is, the folder name after Users/home is hidden."""
_QUOTED = re.compile(r"""(?P<q>['"])(?:\\.|(?!(?P=q)).)*(?P=q)""")
_LOG_RECORD = re.compile(
    r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d,\d+ (?P<level>[A-Z]+)\s+\[\d+\] (?P<name>[\w.]+): "
)
_KEEP_LEVELS = {"WARNING", "ERROR", "CRITICAL"}


def _home_pattern() -> re.Pattern[str] | None:
    """The home folder in any spelling: any separator form, `:` or `%3A`, any letter case."""
    home = Path.home()
    parts = [p for p in re.split(r"[\\/]+", str(home)) if p]
    if len(parts) < 2:
        return None
    escaped = [re.escape(p).replace(":", "(?::|%3A)").replace(r"\ ", "(?: |%20)") for p in parts]
    lead = "" if re.match(r"^[A-Za-z]:", parts[0]) else _SEP
    return re.compile(lead + _SEP.join(escaped), re.IGNORECASE)


def _names_to_hide() -> list[str]:
    """This laptop's user name, from the home folder and the environment (at least 3
    characters, so a short one doesn't eat ordinary words)."""
    names = {Path.home().name}
    for var in ("USERNAME", "USER", "LOGNAME"):
        names.add(os.environ.get(var, ""))
    return sorted((n for n in names if len(n) >= 3), key=len, reverse=True)


def redact(text: str) -> str:
    r"""Hide what could name the laptop's user or echo the owner's records:

    - the home folder, in every spelling (\, \\, /, URL-encoded, any letter case), becomes `~`,
      and any other `Users\<name>` / `/home/<name>` folder (8.3 short names too) becomes
      `Users\<user>`;
    - the user's name anywhere else becomes `<user>`;
    - the values SQLAlchemy prints after a database error (`[parameters: ...]`) are hidden.
    """
    home = _home_pattern()
    if home is not None:
        text = home.sub("~", text)
    for name in _names_to_hide():
        text = re.sub(re.escape(name), "<user>", text, flags=re.IGNORECASE)
    text = _USER_DIR.sub(
        lambda m: (
            f"{m['lead']}{m['dir']}{m['sep']}<user>" if m["name"].lower() != "<user>" else m[0]
        ),
        text,
    )
    lines = []
    for line in text.split("\n"):
        if "[parameters:" in line:
            line = line[: line.index("[parameters:")] + "[parameters: hidden]"
        lines.append(line)
    return "\n".join(lines)


def _strip_values(line: str) -> str:
    """Quoted values in an error message (`invalid literal for int(): 'Ananya'`, a validation
    error's `'input': '...'`) become `'…'`. Traceback file lines keep their (redacted) path."""
    if line.lstrip().startswith('File "'):
        return line
    return _QUOTED.sub(lambda m: f"{m['q']}…{m['q']}", line)


def _worth_sending(lines: list[str]) -> list[str]:
    """Warnings and errors (with their tracebacks), and the app's own notes (`scrappy`: startup,
    backups, feedback); not other libraries' chatter. A line that isn't the start of a record
    belongs to the one before it."""
    kept: list[str] = []
    keep = False
    for line in lines:
        record = _LOG_RECORD.match(line)
        if record:
            keep = record["level"] in _KEEP_LEVELS or record["name"].split(".")[0] == "scrappy"
        if keep:
            kept.append(line)
    return kept


def _last_lines(path: Path, count: int) -> list[str]:
    try:
        with path.open("rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - _READ_BYTES))
            data = f.read()
    except OSError:
        return []
    lines = data.decode("utf-8", errors="replace").splitlines()
    if size > _READ_BYTES and lines:
        lines = lines[1:]  # the first line is probably cut in half
    return lines[-count:] if count > 0 else []


def log_tail(count: int = LOG_TAIL_LINES) -> str:
    """The last `count` lines worth sending from `server.log` (reaching into `server.log.1` when
    the current file has just rotated): warnings, errors and their tracebacks, and the app's own
    notes, redacted, quoted values hidden, each at most 500 characters, 64 KB at most in all."""
    current = logs.log_file()
    older = current.with_name(current.name + ".1")
    lines = _worth_sending(_last_lines(older, _SCAN_LINES) + _last_lines(current, _SCAN_LINES))
    lines = lines[-count:] if count > 0 else []
    trimmed = [
        line if len(line) <= LOG_LINE_MAX_CHARS else line[:LOG_LINE_MAX_CHARS] + "…"
        for line in (_strip_values(redact(line)) for line in lines)
    ]
    text = "\n".join(trimmed)
    if len(text) > LOG_TAIL_MAX_CHARS:
        text = text[-LOG_TAIL_MAX_CHARS:]
        text = text[text.find("\n") + 1 :] if "\n" in text else text
    return text


# --------------------------------------------------------------------------- environment


def server_environment(db_revision: str | None = None) -> dict[str, str]:
    """Facts about the app and the laptop (no paths, no names, no records)."""
    now = dt.datetime.now().astimezone()
    return {
        "app_version": __version__,
        "build_id": build_id(),
        "os": platform.platform(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "db_revision": db_revision or "none",
        "server_time": now.isoformat(timespec="seconds"),
        "server_timezone": now.tzname() or "",
    }
