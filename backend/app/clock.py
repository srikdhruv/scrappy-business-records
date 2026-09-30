"""The current month, from the laptop's local clock.

Routers get it through `CurrentMonthDep` and never read the clock themselves, so tests can
freeze it with `app.dependency_overrides[get_current_month] = lambda: date(2026, 10, 1)`.
"""

from __future__ import annotations

import datetime as dt
from typing import Annotated

from fastapi import Depends

from app.months import current_month


def get_current_month() -> dt.date:
    """First day of the current month (local time)."""
    return current_month()


CurrentMonthDep = Annotated[dt.date, Depends(get_current_month)]
"""Use as a router parameter type: `def handler(current: CurrentMonthDep): ...`."""
