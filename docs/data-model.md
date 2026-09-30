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

### Database safeguards

The database itself rejects bad rows, as a last line of defence behind the API's validation:

- Every month column holds a real **first-of-month date**:
  `CHECK (col IS date(col, 'start of month'))`. This rejects `'garbage'`, `'2026-10'`,
  `20261001` and `'2026-10-05'`. `paid_on` must be a real date (`paid_on IS date(paid_on)`).
- `students.left_month ≥ joined_month`, and `name` isn't blank.
- `fee_changes.amount_paise ≥ 0`, and `(student_id, effective_month)` is unique.
- `payments.amount_paise > 0`, and `method` is one of `upi`, `cash`, `other`.
- Foreign keys are enforced (`PRAGMA foreign_keys=ON` on every connection), so deleting a student
  deletes their fee changes and payments.

Indexes: `students(name)`, `payments(student_id, for_month)`, `payments(for_month)` and
`payments(paid_on)`.

## API (all under `/api`)

FastAPI serves interactive docs at `/api/docs` and the schema at `/api/openapi.json`. The
request and response models are in `backend/app/schemas.py`. Their names (`StudentRead`,
`PaymentCreate`, `DashboardResponse`, …) are also the TypeScript type names in
`frontend/src/api/schema.d.ts`.

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

**Errors.**
- **404** (missing resource): `{"detail": "No student with id 3"}` (`ErrorResponse`).
- **422**: always FastAPI's validation shape (`HTTPValidationError`),
  `{"detail": [{"loc": ["body", "left_month"], "msg": "...", "type": "value_error"}]}`. This
  includes business rules that routers check against stored data; raise those with
  `app.errors.unprocessable(msg, field=...)`. Never let a database CHECK surface as a 500.
- The UI's `ApiError` (`frontend/src/api/client.ts`) turns either shape into readable `messages`
  and a per-field `fields` map.

**Status codes.** `POST` answers 201 with the created object. `DELETE` answers 204 with no body.

### Response shapes

| Model | Fields |
|---|---|
| `StudentRead` (list item) | `id`, `name`, `phone`, `guardian_name`, `batch_label`, `joined_month`, `left_month`, `notes`, `is_active`, `monthly_fee_paise`, `balance_paise` (negative = owes), `status`, `created_at`, `updated_at` |
| `StudentDetail` (`GET`/`POST`/`PATCH` of one student) | `StudentRead`, plus `fee_history[]` (`FeeChangeRead`), `months[]` (`LedgerMonth`), `payment_count` and `total_paid_paise` |
| `LedgerMonth` | `month`, `expected_paise`, `paid_paise`, `remaining_paise` (`max(0, expected − paid)`), `excess_paise` (`max(0, paid − expected)`), `status`, `is_due` (month ≤ current month) |
| `PaymentRead` | `id`, `student_id`, `student_name`, `amount_paise`, `paid_on`, `for_month`, `method`, `note`, `created_at`, `updated_at` |
| `DashboardResponse` | `month`, `summary` (`expected_paise`, `collected_paise`, `still_due_paise`, `not_fully_paid_count`, `active_student_count`), `yet_to_pay[]`, `backlog[]` (each with `months[]` and `total_owed_paise`) and `overpaid[]` (student-months with `excess_paise`) |
| `SuggestedPayment` | `for_month`, `amount_paise` |
| `HealthResponse` | `app`, `version`, `status` |

**Enums.**
- `MonthStatus`: `paid`, `partial`, `unpaid`, `overpaid`, `not_applicable`.
- `BalanceStatus`: `up_to_date`, `owes`, `credit`.
- `PaymentMethod`: `upi`, `cash`, `other`.

**Lists.** `GET /students` and `GET /payments` return plain JSON arrays, **unpaginated**: at
this scale (thousands of payments at most) one response is small and fast. Students are sorted by
name. Payments default to `sort=paid_on&order=desc`. The server filters by `student_id`,
`month` and `q`. The UI filters by **method** and **paid-on date range** on the client, over the
list it already has, so there are no query parameters for those.

**Timestamps.** `created_at` and `updated_at` are UTC with a trailing `Z`, e.g.
`"2026-10-05T09:30:00Z"`.

**Validation.**
- Months must match `YYYY-MM`.
- Payment amounts must be more than 0. Fees can be 0 or more.
- **Amount cap.** A single payment (`amount_paise`) or monthly fee (`monthly_fee_paise`) can be
  at most **₹10,00,000** (`100000000` paise). This guards against typos like an extra zero; it
  isn't a business rule.
  - Backend: `MAX_AMOUNT_PAISE` in `app/schemas.py` (`le=`), so a larger amount gets a 422.
  - Frontend: `MAX_AMOUNT_PAISE` in `src/lib/format.ts`, where `rupeesToPaise` returns null
    above it.

  The two constants must match; each side has a test that pins the value. Response amounts
  aren't capped, because totals such as a student's whole backlog can exceed it.
- Schema rules report the field they're about. For example, a left month before the joined month
  gives `loc: ["body", "left_month"]` with the plain-words `msg` "Left month can't be before the
  joined month". A blank name gives "Name is required". The UI shows `msg` as-is.
- Blank optional text becomes `null`, and unknown fields are rejected.
- `PATCH` bodies are partial: only the fields that are sent change. Sending `left_month: null`
  un-archives a student.

**Editing a student (`PATCH /students/{id}`).** These rules need the stored student, so the
router checks them. Each failure is a 422 in the shape above:

1. **Moving `joined_month`** moves the earliest fee change's `effective_month` with it, so the
   first owed month always has a fee. If the new joined month is on or after a *later* fee
   change, answer 422, because the earliest fee would be lost.
2. **`fee_effective_month` before `joined_month`** → 422. Use the new `joined_month` if one is
   sent, otherwise the stored one. A fee change for a month that already has one replaces its
   amount.
3. **`left_month` before `joined_month`** → 422. Again, use the new `joined_month` if sent,
   otherwise the stored one. This must be a 422, not a 500 from the database CHECK.

## Ledger computation

The ledger is computed in `services/ledger.py` from a student, their fee changes and their
payments. Nothing derived is stored, so there is no way for it to drift out of sync.

At this scale (hundreds of students, thousands of payments) computing it on every request is
effectively instant.
