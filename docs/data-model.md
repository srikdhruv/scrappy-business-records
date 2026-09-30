# Data model and API

## Conventions

- **Money** is stored and sent as **integer paise** (₹1,500 = `150000`). The UI converts it for
  display.
- **Months** are `"YYYY-MM"` strings in the API and first-of-month `DATE` values in the database.
- **Dates** are ISO `"YYYY-MM-DD"` strings.
- **Timestamps** are UTC.
- The "current month" is taken from the laptop's local clock.

## Tables

### `students`
| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT NOT NULL | |
| `phone` | TEXT NULL | |
| `guardian_name` | TEXT NULL | |
| `batch_label` | TEXT NULL | Free text for now; see future-features §1 |
| `joined_month` | DATE NOT NULL | First month they owe |
| `left_month` | DATE NULL | Last month they owe; set means *archived* |
| `notes` | TEXT NULL | |
| `created_at`, `updated_at` | DATETIME | |

### `fee_changes`
The fee in effect for month *m* comes from the row with the greatest `effective_month ≤ m`.
Creating a student inserts the first row at `joined_month`.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `student_id` | FK → students ON DELETE CASCADE | |
| `effective_month` | DATE NOT NULL | UNIQUE with `student_id` |
| `amount_paise` | INTEGER NOT NULL | ≥ 0 |
| `created_at` | DATETIME | |

### `payments`
| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `student_id` | FK → students ON DELETE CASCADE | Indexed with `for_month` |
| `amount_paise` | INTEGER NOT NULL | > 0 |
| `paid_on` | DATE NOT NULL | |
| `for_month` | DATE NOT NULL | Indexed |
| `method` | TEXT NOT NULL | `upi` / `cash` / `other` |
| `note` | TEXT NULL | |
| `created_at`, `updated_at` | DATETIME | |

## API (all under `/api`)

FastAPI serves interactive docs at `/api/docs` in dev.

| Method & path | Purpose |
|---|---|
| `GET /health` | `{"app": "scrappy-records", "version": "0.1.0", "status": "ok"}` |
| `GET /students?status=active\|left\|all&q=` | List of students, each with `monthly_fee_paise` (current fee), `balance_paise` and `status` (`up_to_date` / `owes` / `credit`) |
| `POST /students` | Create. Body: `name`, `monthly_fee_paise`, `joined_month`, and optionally `phone`, `guardian_name`, `batch_label`, `notes`, `left_month` |
| `GET /students/{id}` | Detail, including `fee_history`, `months[]` (the ledger, one row per month from `joined_month` to the current month or the last paid month) and `payment_count` |
| `PATCH /students/{id}` | Partial update. A new fee is sent as `monthly_fee_paise` + `fee_effective_month` (which defaults to the current month) |
| `DELETE /students/{id}` | Hard delete. Payments cascade |
| `GET /payments?student_id=&month=&q=&sort=paid_on\|for_month\|amount\|student\|method&order=asc\|desc` | List, including `student_name` |
| `POST /payments` | Create. Body: `student_id`, `amount_paise`, `paid_on`, `for_month`, `method`, `note?` |
| `GET /payments/{id}` · `PATCH /payments/{id}` · `DELETE /payments/{id}` | |
| `GET /dashboard?month=YYYY-MM` | See the PRD's "Dashboard for a selected month M" section. Returns `summary`, `yet_to_pay[]`, `backlog[]` and `overpaid[]` |
| `GET /students/{id}/suggest-payment` | `{for_month, amount_paise}`: the oldest unpaid or partial month and its remaining amount, otherwise the current month and its fee |

**Errors** use FastAPI's standard shape: 422 for validation, 404 for a missing resource.

## Ledger computation

The ledger is computed in `services/ledger.py` from a student, their fee changes and their
payments. Nothing derived is stored, so there is no way for it to drift out of sync.

At this scale (hundreds of students, thousands of payments) computing it on every request is
effectively instant.
