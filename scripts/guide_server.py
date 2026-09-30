"""The real app with the clock frozen, for the feature guide's pictures (`make guide-screenshots`).

    uv run --project backend python scripts/guide_server.py seed  --today 2026-09-15
    uv run --project backend python scripts/guide_server.py serve --today 2026-09-15 --port 57001

`seed` fills `$SCRAPPY_HOME` with the fictional demo data as of `--today`; `serve` runs the same
FastAPI app as `python -m app`, with `app.clock.get_today` overridden to `--today`, so every
number and date on screen is the same whenever the pictures are retaken. The app itself has no
way to change its clock: this override lives only here, the way the tests freeze time.

Both need `SCRAPPY_HOME` (and `SCRAPPY_BACKUP_DIR`) set to a throwaway folder.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import sys

import uvicorn
from sqlalchemy.orm import Session

from app import config, migrate
from app.clock import get_today
from app.db import get_engine
from app.main import create_app
from app.seed import seed


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=("seed", "serve"))
    parser.add_argument("--today", type=dt.date.fromisoformat, required=True)
    parser.add_argument("--port", type=int, default=0)
    args = parser.parse_args(argv)

    if not os.environ.get("SCRAPPY_HOME", "").strip():
        print("Set SCRAPPY_HOME to a throwaway folder first.", file=sys.stderr)
        return 1

    if args.command == "seed":
        config.ensure_dirs()
        migrate.upgrade_to_head()
        with Session(get_engine()) as session:
            added = seed(session, args.today)
        print(f"Added {added} demo students as of {args.today:%d %b %Y}")
        return 0

    app = create_app()
    app.dependency_overrides[get_today] = lambda: args.today
    uvicorn.run(app, host=config.HOST, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
