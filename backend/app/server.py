"""`python -m app.server`: run the server the way the Desktop shortcut does.

The launcher starts this with `pythonw.exe` (no console window). That's why logging is set up
here in code, into the rotating `logs/server.log`, and uvicorn is told not to configure logging
or use colours: its default config writes to `sys.stdout`, which doesn't exist under pythonw.

    python -m app.server            # 127.0.0.1:$SCRAPPY_PORT (default 8765)
"""

from __future__ import annotations

import logging

import uvicorn

from app import __version__, config, logs


def main() -> None:
    logs.ensure_std_streams()
    log_path = logs.setup(rotate=True)
    logging.getLogger("scrappy").info(
        "Starting Scrappy Records %s on http://%s:%d (log: %s)",
        __version__,
        config.HOST,
        config.port(),
        log_path,
    )
    uvicorn.run(
        "app.main:app",
        host=config.HOST,
        port=config.port(),
        log_config=None,
        use_colors=False,
        access_log=False,
        # Don't hang around for keep-alive browser connections on shutdown.
        timeout_graceful_shutdown=3,
    )


if __name__ == "__main__":
    main()
