# Data model and API

## Conventions

- **Money** is stored and sent as **integer paise** (₹1,500 = `150000`). The UI converts it for
  display.
- **Months** are `"YYYY-MM"` strings in the API and first-of-month `DATE` values in the database.
- **Dates** are ISO `"YYYY-MM-DD"` strings.
- **Timestamps** are UTC.
- "Today" and the "current month" come from the laptop's local clock, through one FastAPI
  dependency (`app.clock.get_today`; `get_current_month` is derived from it) that tests override
  to freeze time. Responses that depend on it include `current_month`, so the UI never needs its
  own clock for business rules.

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
| `left_month` | DATE NULL | Last month they owe. Once it has passed, the student is *Left* (archived) |
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
| `GET /students?status=active\|left\|all&q=` | List of students, each with `monthly_fee_paise` (current fee), `balance_paise` and `status` (`up_to_date` / `owes` / `credit`). `active` (default) = not left yet (no `left_month`, or `left_month ≥` the current month); `left` = the left month has passed. `q` matches name, guardian or phone, ignoring case and accents (and spaces in phone numbers). Sorted by name, ignoring case and accents |
| `POST /students` | Create. Body: `name`, `monthly_fee_paise`, `joined_month`, and optionally `phone`, `guardian_name`, `batch_label`, `notes`, `left_month` |
| `GET /students/{id}` | Detail, including `fee_history`, `months[]` (the ledger; see [Ledger computation](#ledger-computation)) and `payment_count` (so the UI can warn before a delete) |
| `PATCH /students/{id}` | Partial update. A new fee is sent as `monthly_fee_paise` + `fee_effective_month` (which defaults to the current month, or `joined_month` if that is later). See the edit rules below |
| `DELETE /students/{id}` | Hard delete. Payments cascade |
| `GET /payments?student_id=&month=&q=&sort=paid_on\|for_month\|amount\|student\|method&order=asc\|desc` | List, including `student_name`. `month` matches `for_month`; `q` matches the student's name or the note, ignoring case and accents ("emile" finds "Émile"). `sort=student` sorts by name ignoring case and accents; `method` sorts `cash`, `other`, `upi`. Ties go to the latest `paid_on`, then the newest entry |
| `POST /payments` | Create. Body: `student_id`, `amount_paise`, `paid_on`, `for_month`, `method`, `note?`. 404 if the student doesn't exist. Any `for_month` within the [limits](#limits) is accepted, even one the student isn't active in (it then shows as overpaid) |
| `GET /payments/{id}` · `PATCH /payments/{id}` · `DELETE /payments/{id}` | `PATCH` may move a payment to another student (404 if that student doesn't exist) |
| `GET /dashboard?month=YYYY-MM` | See the PRD's "Dashboard for a selected month M" section. Returns `month`, `current_month`, `summary`, `yet_to_pay[]`, `backlog[]` and `overpaid[]` |
| `GET /students/{id}/suggest-payment` | `{for_month, amount_paise, reason}`, as in the PRD's ledger rule 9. `reason` is `owed` (the oldest *due* month that is unpaid or partial, and what's left on it), `next_unpaid` (nothing is owed yet: the first enrolled month after the current month that isn't paid, and what's left on it), or `all_paid` (nothing is left in the enrolled months up to 24 months ahead, the latest month a payment can be logged for; `for_month` and `amount_paise` are `null`). `amount_paise` is also `null` for a month whose fee is 0. It never suggests a month that is already fully paid, one outside the months the student is enrolled in, or one more than 24 months ahead |

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
| `StudentRead` (list item) | `id`, `name`, `phone`, `guardian_name`, `batch_label`, `joined_month`, `left_month`, `notes`, `is_active`, `monthly_fee_paise`, `balance_paise` (negative = owes), `status`, `credit_paise` (money in overpaid months; see below), `tenure_months`, `current_month`, `created_at`, `updated_at` |
| `StudentDetail` (`GET`/`POST`/`PATCH` of one student) | `StudentRead`, plus `fee_history[]` (`FeeChangeRead`), `months[]` (`LedgerMonth`), `payment_count` and `total_paid_paise` |
| `LedgerMonth` | `month`, `expected_paise`, `paid_paise`, `remaining_paise` (`max(0, expected − paid)`), `excess_paise` (`max(0, paid − expected)`), `status`, `is_due` (month ≤ current month) |
| `PaymentRead` | `id`, `student_id`, `student_name`, `amount_paise`, `paid_on`, `for_month`, `method`, `note`, `created_at`, `updated_at` |
| `DashboardResponse` | `month`, `summary` (`expected_paise`, `collected_paise`, `still_due_paise`, `not_fully_paid_count`, `active_student_count`), `current_month`, `yet_to_pay[]` (each with `credit_paise`), `backlog[]` (each with `months[]`, `total_owed_paise` and `credit_paise`) and `overpaid[]` (student-months with `batch_label`, `phone` and `excess_paise`) |
| `SuggestedPayment` | `for_month` (nullable), `amount_paise` (nullable), `reason` |
| `HealthResponse` | `app`, `version`, `status` |

**Enums.**
- `MonthStatus`: `paid`, `partial`, `unpaid`, `overpaid`, `not_applicable`.
- `BalanceStatus`: `up_to_date`, `owes`, `credit`.
- `SuggestionReason`: `owed`, `next_unpaid`, `all_paid`.
- `PaymentMethod`: `upi`, `cash`, `other`.

**Lists.** `GET /students` and `GET /payments` return plain JSON arrays, **unpaginated**: at
this scale (thousands of payments at most) one response is small and fast. Students are sorted by
name. Payments default to `sort=paid_on&order=desc`. The server filters by `student_id`,
`month` and `q`. The UI filters by **method** on the client, over the list it already has, so
there is no query parameter for it. The Payments page sorts on the client too (click a column
heading), so changing the sort doesn't refetch.

**Timestamps.** `created_at` and `updated_at` are UTC with a trailing `Z`, e.g.
`"2026-10-05T09:30:00Z"`.

**Validation.**
- Months must match `YYYY-MM`, with a year from 2000 to 2099. See also [Limits](#limits).
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

### Limits

Typo guards, checked against today's date in `app/services/bounds.py`. Each gives a plain-words
422 naming the field, e.g. `loc: ["body", "for_month"]`, "Month can't be later than June 2028
(two years from now)":

- A month someone sets (`joined_month`, `left_month`, `fee_effective_month` or a payment's
  `for_month`) can be at most **24 months after the current month**.
- A payment's `paid_on` must be between **2000-01-01** and **tomorrow** (one day of slack for a
  laptop clock that is a little behind).
- Text with characters that can't be saved is a 422, "This text has a character that can't
  be saved". That means a lone half of a UTF-16 pair (sent as `"\ud800"`), or any control
  character (NUL, escape, …) except tab and line breaks (`\t`, `\n`, `\r`).
- Ids and amounts (`student_id`, `amount_paise`, `monthly_fee_paise`) must be JSON whole
  numbers: `true`, `1.5`, `"100"`, `NaN`, `Infinity` and `1e400` are all 422s.
- Ids too large for the database are simply "not found" (404), or match nothing in a filter.
- A 422 that echoes the bad input is always sendable: unencodable characters become `?`, and
  non-finite numbers become strings (`app.errors.validation_error_handler`).

No input may cause a 500. `tests/test_fuzz.py` sends random bodies, ids, query strings and raw
bytes to every endpoint to check this.

**Editing a student (`PATCH /students/{id}`).** These rules need the stored student, so the
router checks them. Each failure is a 422 in the shape above:

1. **Moving `joined_month`** moves the earliest fee change's `effective_month` with it, so the
   first owed month always has a fee. If the new joined month is on or after a *later* fee
   change, answer 422, because the earliest fee would be lost.
2. **`fee_effective_month` before `joined_month`** → 422. Use the new `joined_month` if one is
   sent, otherwise the stored one. A fee change for a month that already has one replaces its
   amount. If that fee is already in effect for that month, nothing is recorded (so re-saving
   an unchanged edit form adds no rows). Earlier and later fee changes are kept.
3. **`left_month` before `joined_month`** → 422. Again, use the new `joined_month` if sent,
   otherwise the stored one. This must be a 422, not a 500 from the database CHECK.

## Ledger computation

The ledger is computed in `services/ledger.py` from a student, their fee changes and their
payments. Nothing derived is stored, so there is no way for it to drift out of sync. The
functions are pure: the current month is passed in, never read from the clock. The rules are
the PRD's [Ledger rules](product/prd.md#ledger-rules); the details below are how they apply at
the edges.

- **Fee in effect.** From the fee change with the greatest `effective_month ≤ m`; 0 if there is
  none (which the API never allows to happen: the earliest fee change is always at
  `joined_month`).
- **Profile months (`months[]`).** One row per month, contiguous, from `joined_month` (or the
  earliest month with a payment, if that is earlier) to the latest of: the current month, the
  latest month with a payment, and `joined_month`. So it includes inactive months that have
  payments, months after a student left (Not applicable), and a future joining month.
- **Months after the current month** get the same status rule as any other (for example
  `paid` when paid ahead in full, `unpaid` when not), with `is_due: false`. They never count
  as owed and never appear in *Backlog* or *Overpaid*. A payment for one still adds to the
  balance (which can then be positive, shown as *Credit*), but not to `credit_paise`.
- **`credit_paise`** (PRD ledger rule 10) is the money in overpaid months: the sum of
  `max(0, paid − expected)` over months up to and including the current month, including
  payments for months the student isn't enrolled in. It is shown next to students who still
  owe (the students list, the profile, and the dashboard's *Yet to pay* and *Backlog*) so the
  owner can move the payment to the right month. Payments are never moved or split
  automatically.
- **`tenure_months`** counts the months from `joined_month` to the current month (or
  `left_month`, if earlier), both included; 0 before they join.
- **Current fee (`monthly_fee_paise`)** is the fee in effect this month, or in `joined_month`
  for a student who hasn't joined yet.
- **`is_active`** (and the `status=active|left` filter) is the PRD's ledger rule 8: true while
  `left_month` is empty or `left_month ≥` the current month. A student leaving after December
  is active through December and left from January. It depends on the current month, so it is
  computed, never stored.
- **Dashboard lists** are sorted by student name, ignoring case and accents. Overpaid rows are
  oldest month first within a student.

At this scale (hundreds of students, thousands of payments) computing it on every request is
effectively instant.
