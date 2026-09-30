"""Print the OpenAPI schema as JSON without starting a server (used by `make gen-api`).

uv run python -m app.openapi_dump > openapi.json
"""

import json
import sys

from app.main import create_app


def main() -> None:
    schema = create_app().openapi()
    json.dump(schema, sys.stdout, indent=2, sort_keys=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
