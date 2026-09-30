"""Business logic, kept out of the routers.

- `ledger.py`: the business rules as pure functions (no database, no clock, no I/O).
- `students.py`, `payments.py`, `dashboard.py`: load and save rows, apply the ledger rules, and
  return the response models from `app.schemas`. Routers call these and nothing else.
"""
