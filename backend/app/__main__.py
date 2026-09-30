"""`python -m app` (or `pythonw -m app`): serve the app on 127.0.0.1:$SCRAPPY_PORT (default 8765).

This is how the server is always started, including by the Desktop launcher, which runs it with
`pythonw.exe` so no console window appears. Under `pythonw`, `sys.stdout` and `sys.stderr` are
None, and uvicorn's default logging config crashes on them ("Unable to configure formatter
'default'"). So uvicorn gets `log_config=None` and `use_colors=False`, and we only attach a
plain console handler when there is a console. uvicorn's loggers propagate to the root logger,
so a file handler added there (the packaging PR's rotating log) receives them too.
"""

from __future__ import annotations

import logging
import sys

import uvicorn

from app import config, logs

LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


def configure_console_logging() -> None:
    """Log INFO+ to stderr when there is one; do nothing under pythonw (no console)."""
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    if sys.stderr is not None:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter(LOG_FORMAT))
        root.addHandler(handler)


def server_config() -> uvicorn.Config:
    return uvicorn.Config(
        "app.main:app",
        host=config.HOST,
        port=config.port(),
        log_config=None,  # don't let uvicorn configure logging (it assumes a console)
        use_colors=False,
        log_level="info",
    )


def main() -> None:
    configure_console_logging()
    logs.setup(rotate=True)  # logs/server.log, rotating (app/logs.py)
    uvicorn.Server(server_config()).run()


if __name__ == "__main__":
    main()
