"""`python -m app`: serve the app on 127.0.0.1 (port from SCRAPPY_PORT, default 8765)."""

import uvicorn

from app import config


def main() -> None:
    uvicorn.run("app.main:app", host=config.HOST, port=config.port(), log_level="info")


if __name__ == "__main__":
    main()
