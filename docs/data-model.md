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
Creating a student inserts the first row at `joined_month`. That first row is never removed
(moving `joined_month` moves it). A later row can be removed only while it hasn't started
(`DELETE /students/{id}/fee-changes/{fee_change_id}`). Coming back after leaving
(`POST /students/{id}/return`) writes a ₹0 row with `kind = 'away'` for the months away, so
the app can tell them apart from a ₹0 the owner set on purpose (a month off, a free place).

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `student_id` | FK → students ON DELETE CASCADE | |
| `effective_month` | DATE NOT NULL | UNIQUE with `student_id` |
| `amount_paise` | INTEGER NOT NULL | ≥ 0 |
| `kind` | TEXT NOT NULL, default `'fee'` | `'fee'`: set by the owner. `'away'`: the months away, written by coming back (always ₹0: `CHECK (kind = 'fee' OR amount_paise = 0)`). Added by migration `0002`, which made every existing row `'fee'` (nothing with coming back had been released, and an old ₹0 row can't be told apart from a month off). The owner setting a fee on an `'away'` month makes it a `'fee'` |
| `created_at` | DATETIME | |

### `payments`
A payment is stored exactly as it was typed. Where its money goes (its own month, other months
still owed, or credit) is worked out every time and never stored: see
[Credit allocation](#credit-allocation).

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

Changes to these tables only ever **add** (new tables, or new columns that are nullable or have a
default): nothing stored is dropped, renamed, retyped or rewritten by a migration. See
[ADR 0004](adr/0004-data-is-never-lost.md).

## API (all under `/api`)

FastAPI serves interactive docs at `/api/docs` and the schema at `/api/openapi.json`. The
request and response models are in `backend/app/schemas.py`. Their names (`StudentRead`,
`PaymentCreate`, `DashboardResponse`, …) are also the TypeScript type names in
`frontend/src/api/schema.d.ts`.

| Method & path | Purpose |
|---|---|
| `GET /health` | `{"app": "scrappy-records", "version": "0.1.0", "status": "ok"}` |
| `GET /students?status=active\|left\|all&q=` | List of students, each with `monthly_fee_paise` (current fee), `status` (`owes` / `credit` / `up_to_date`), `owed_paise`, `credit_paise`, `paid_ahead_paise` (all three after [credit allocation](#credit-allocation)) and the net `balance_paise`. `active` (default) = not left yet (no `left_month`, or `left_month ≥` the current month); `left` = the left month has passed. `q` matches name, guardian or phone, ignoring case and accents (and spaces in phone numbers). Sorted by name, ignoring case and accents |
| `POST /students` | Create. Body: `name`, `monthly_fee_paise`, `joined_month`, and optionally `phone`, `guardian_name`, `batch_label`, `notes`, `left_month` |
| `GET /students/{id}` | Detail, including `fee_history`, `months[]` (the ledger; see [Ledger computation](#ledger-computation)) and `payment_count` (so the UI can warn before a delete) |
| `PATCH /students/{id}` | Partial update. A new fee is sent as `monthly_fee_paise` + `fee_effective_month` (which defaults to the current month, or `joined_month` if that is later). See the edit rules below |
| `DELETE /students/{id}` | Hard delete. Payments cascade |
| `POST /students/{id}/return` | A student who left comes again (PRD ledger rule 11). Body: `{from_month, monthly_fee_paise?}`; `from_month` is any month after `left_month` and at most 24 months ahead. In one transaction, holding the write lock: a ₹0 fee change at the month after `left_month` (none if `from_month` is that month), fee changes in the gap between them removed, every `'away'` row after `left_month` removed, `monthly_fee_paise` (default: `return_fee`, the latest `'fee'` row on or before `from_month`) recorded from `from_month`, and `left_month` cleared. Answers 200 with the `StudentDetail`. 422 on `from_month` if they haven't been marked as left, or the month is too early or too late. See [Coming back after leaving](#coming-back-after-leaving) |
| `DELETE /students/{id}/fee-changes/{fee_change_id}` | Remove a fee change that hasn't started yet (its month is after the current month); the fee before it carries on. 204. 404 if the student, or that fee change of theirs, doesn't exist. 422 (`loc: ["path", "fee_change_id"]`) for the first fee, one that has already started, or the fee they came back on (a `'fee'` row right after an `'away'` one: "This is the fee they came back on. To change it, set a new fee in Edit.") |
| `GET /payments?student_id=&month=&q=&sort=paid_on\|for_month\|amount\|student\|method&order=asc\|desc` | List, including `student_name` and where each payment's money went (`paid_direct_paise`, `extra_sent[]`, `extra_unused_paise`; see [Credit allocation](#credit-allocation)). Always three queries (students, fee changes, payments), however many rows. `month` matches `for_month`; `q` matches the student's name or the note, ignoring case and accents ("emile" finds "Émile"). `sort=student` sorts by name ignoring case and accents; `method` sorts `cash`, `other`, `upi`. Ties go to the latest `paid_on`, then the newest entry |
| `POST /payments` | Create. Body: `student_id`, `amount_paise`, `paid_on`, `for_month`, `method`, `note?`. 404 if the student doesn't exist. Any `for_month` within the [limits](#limits) is accepted, even one the student isn't active in (all of it is then extra, and pays the oldest month owed). Answers with the `PaymentRead`, including where its money went |
| `GET /payments/{id}` · `PATCH /payments/{id}` · `DELETE /payments/{id}` | `PATCH` may move a payment to another student (404 if that student doesn't exist). An edit or delete changes where that payment's extra goes at once (nothing is stored) |
| `GET /dashboard?month=YYYY-MM` | See the PRD's "Dashboard for a selected month M" section. Returns `month`, `current_month`, `summary`, `yet_to_pay[]`, `backlog[]`, `overpaid[]` (months holding credit) and `credit_moves[]` |
| `GET /students/{id}/suggest-payment` | `{for_month, amount_paise, reason}`, as in the PRD's ledger rule 9. `reason` is `owed` (the oldest *due* month that is unpaid or partial, and what's left on it), `next_unpaid` (nothing is owed yet: the first enrolled month after the current month that has a fee and isn't fully paid, and what's left on it; months with a ₹0 fee are skipped), or `all_paid` (nothing is left in the enrolled months up to 24 months ahead, the latest month a payment can be logged for; `for_month` and `amount_paise` are `null`). It never suggests a month that is already fully paid, one with a ₹0 fee, one outside the months the student is enrolled in, or one more than 24 months ahead |

**Errors.**
- **404** (missing resource): `{"detail": "No student with id 3"}` (`ErrorResponse`).
- **422**: always FastAPI's validation shape (`HTTPValidationError`),
  `{"detail": [{"loc": ["body", "left_month"], "msg": "...", "type": "value_error"}]}`. This
  includes business rules that routers check against stored data; raise those with
  `app.errors.unprocessable(msg, field=...)`. Never let a database CHECK surface as a 500.
- The UI's `ApiError` (`frontend/src/api/client.ts`) turns either shape into readable `messages`
  and a per-field `fields` map.

**Status codes.** `POST` answers 201 with the created object (`POST /students/{id}/return`
creates nothing, so it answers 200). `DELETE` answers 204 with no body.

### Response shapes

| Model | Fields |
|---|---|
| `StudentRead` (list item) | `id`, `name`, `phone`, `guardian_name`, `batch_label`, `joined_month`, `left_month`, `notes`, `is_active`, `monthly_fee_paise`, `status` (see below), `owed_paise`, `credit_paise` (money no month needed), `paid_ahead_paise`, `balance_paise` (net, for reference only), `tenure_months`, `next_fee_change` (the first `FeeChangeRead` after the month `monthly_fee_paise` is for, or `null`), `current_month`, `created_at`, `updated_at` |
| `StudentDetail` (`GET`/`POST`/`PATCH` of one student) | `StudentRead`, plus `fee_history[]` (`FeeChangeRead`: `id`, `effective_month`, `amount_paise`, `kind`), `months[]` (`LedgerMonth`), `payment_count` and `total_paid_paise` |
| `LedgerMonth` | `month`, `expected_paise`, `paid_paise` (everything logged for the month, as typed), `paid_direct_paise` (the part of it that pays this month: at most the fee), `covered_by_credit_paise` (extra money from payments logged for other months that pays it), `credit_sources[]` (`CreditSource`: where that came from), `extra_sent[]` (`ExtraSent`: where this month's money above its fee went, one per month, oldest first), `extra_unused_paise` (this month's money no month needed: credit), `remaining_paise` (`max(0, expected − paid_direct − covered_by_credit)`), `excess_paise` (`max(0, paid − expected)` = Σ `extra_sent` + `extra_unused_paise`), `status`, `is_due` (month ≤ current month) |
| `CreditSource` | `payment_id`, `paid_on`, `for_month` (the month that payment was logged for), `amount_paise` (how much of it pays this month) |
| `ExtraSent` | `to_month`, `amount_paise` |
| `PaymentRead` | `id`, `student_id`, `student_name`, `amount_paise`, `paid_on`, `for_month`, `method`, `note`, `paid_direct_paise` (the part that pays `for_month`), `needs_check` (worth a glance in case of a typo: it pays 4 or more months ahead, or some of it is kept as credit; `ledger.needs_check`), `months_ahead` (how many months after the current one it pays), `extra_sent[]` (`ExtraSent`: the rest, paying other months, oldest first), `extra_unused_paise` (credit), `created_at`, `updated_at`. Always `amount = paid_direct + Σ extra_sent + extra_unused` |
| `DashboardResponse` | `month`, `summary` (`expected_paise`, `collected_paise` (what pays M: Σ `paid_direct + covered_by_credit` for M over every student), `paid_ahead_paise` (for a month after the current one, the same as `collected_paise`; 0 otherwise), `still_due_paise`, `not_fully_paid_count`, `active_student_count`, `logged_paise` (every payment logged for M, as typed: the Payments page's total for M), `covered_by_credit_paise` (the part of `collected_paise` from other months' payments), `sent_elsewhere_paise` (the part of `logged_paise` that paid other months)), `current_month`, `yet_to_pay[]` (each with `paid_paise`, `covered_by_credit_paise` and `credit_paise`), `backlog[]` (each with `months[]` (`BacklogMonth`, with `covered_by_credit_paise`), `total_owed_paise` and `credit_paise`), `overpaid[]` (`OverpaidItem`: months holding credit, with `batch_label`, `phone`, `excess_paise` and `extra_unused_paise`) and `credit_moves[]` (`CreditMoveItem`) |
| `CreditMoveItem` | Extra money moved into or out of M: `student_id`, `student_name`, `batch_label`, `phone`, `payment_id`, `paid_on`, `from_month` (the month the payment was logged for), `to_month` (the month it pays), `amount_paise`, `payment_amount_paise` (the whole payment), `payment_pays_until` (the latest month the payment pays: `ledger.pays_until`), `payment_needs_check`, `payment_months_ahead`, `payment_extra_unused_paise` (so the check can say why). One per payment and month (the UI groups them by payment); one of the two months is M. Sorted by student name, then `to_month`, then the payment's `(paid_on, id)` |
| `SuggestedPayment` | `for_month` (nullable), `amount_paise` (nullable), `reason` |
| `StudentReturn` (request) | `from_month`, `monthly_fee_paise` (optional) |
| `HealthResponse` | `app`, `version`, `status` |

**Enums.**
- `MonthStatus`: `paid`, `partial`, `unpaid`, `overpaid`, `not_applicable`, from what pays the
  month (see [Credit allocation](#credit-allocation)). **Paid with credit** isn't a separate
  value: it is `paid` with `covered_by_credit_paise > 0`. `overpaid` means some of the month's
  own money is credit (`extra_unused_paise > 0`).
- `BalanceStatus`: `up_to_date`, `owes`, `credit`.
- `SuggestionReason`: `owed`, `next_unpaid`, `all_paid`.
- `PaymentMethod`: `upi`, `cash`, `other`.
- `FeeKind`: `fee`, `away`.

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

- A month someone sets (`joined_month`, `left_month`, `fee_effective_month`, `from_month` or a
  payment's `for_month`) can be at most **24 months after the current month**.
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
   an unchanged edit form adds no rows). Earlier and later fee changes are kept, so the new fee
   lasts until the next later one: the Edit form says so, from `fee_history`.
3. **`left_month` before `joined_month`** → 422. Again, use the new `joined_month` if sent,
   otherwise the stored one. This must be a 422, not a 500 from the database CHECK.
   `left_month: null` clears it as if they never left: every month since counts. That's only
   allowed while the left month hasn't passed (**Mark as staying**). Once it has passed, a
   `left_month` of `null` or a later month is a 422 ("They left after February 2026, so this can only move earlier. If they came back: first set the real last month they paid for before leaving (an earlier one is fine), then use Mark as coming again from the month they came back. Set a new Left month after that if needed."): coming back is `POST /students/{id}/return`. Moving it earlier is fine.
4. **Setting `left_month`** (to a month other than the stored one) removes the `'away'` runs
   that no longer fit (`_drop_stale_away`): a run starts at an `'away'` row and ends before
   the next `'fee'` row. A run that reaches the new left month, or comes after it, goes (those
   months are owed again, up to the left month); one that ended before it stays. The UI
   names those months and asks for a tick before saving (`lib/fees.ts` `awayOwedAgain`,
   `components/away-warning.tsx`). The 422 for moving a passed left month later gives the way
   back: set the real (earlier) left month, then `POST /return` from the month they came
   back.

**Changes at the same moment.** `update_student`, `return_student` and `delete_fee_change`
start with `app.db.lock_for_writing` (`BEGIN IMMEDIATE`), so a second copy of the same change
(a double click) waits for the first to commit and then sees it. Any database rule that still
refuses a write (`IntegrityError`, e.g. a payment for a student deleted at that moment) is a
**409** with a plain `{"detail": "That change clashed with another one saved at the same
moment. Reload the page and check."}`, never a 500.

### Coming back after leaving

`POST /students/{id}/return` with `{from_month}` (PRD ledger rule 11), done in
`services/students.return_student` in one transaction. With `left_month` L and `from_month` B:

| Fee changes before | After |
|---|---|
| At or before L | Kept (the first fee, and earlier absences, are always among them) |
| After L and before B (in the gap) | Removed |
| `'away'` after B | Removed (leftovers of earlier returns) |
| — | An `'away'` ₹0 row at L + 1, if B > L + 1 |
| At B | Its amount becomes the fee they come back on, and it's a `'fee'` |
| — | If none is at B: a `'fee'` row with the fee they come back on, from B (always after a gap, which it ends; otherwise skipped when that fee is already in effect) |
| `'fee'` after B | Kept, a ₹0 month off the owner set included |

So the months L + 1 … B − 1 are *Not applicable* (**No fee**) and never owed. From B they owe
`monthly_fee_paise` if it was sent, else `return_fee`: the latest `'fee'` row on or before B
(never an `'away'` one), so usually the fee they paid when they left, or the latest raise set
before they came back. Leaving again and coming back straight away therefore owes the real
fee, not an old ₹0. Example: left after May at ₹1,500, a raise to ₹1,800 set for July, back from
September: ₹0 from June, ₹1,800 from September. A payment logged for a gap month is all extra,
like any payment for a month with no fee: it pays the oldest month still owed (or later months
ahead). `left_month` is cleared.

## Ledger computation

The ledger is computed in `services/ledger.py` from a student, their fee changes and their
payments. Nothing derived is stored, so there is no way for it to drift out of sync. The
functions are pure: the current month is passed in, never read from the clock. The rules are
the PRD's [Ledger rules](product/prd.md#ledger-rules); the details below are how they apply at
the edges.

- **Fee in effect.** From the fee change with the greatest `effective_month ≤ m`; 0 if there is
  none (which the API never allows to happen: the earliest fee change is always at
  `joined_month`). A ₹0 fee (a free place, or the months away after coming back) makes an
  active month *Not applicable*: never owed, and never suggested for a payment.
- **Profile months (`months[]`).** One row per month, contiguous, from `joined_month` (or the
  earliest month with a payment, if that is earlier) to the latest of: the current month, the
  latest month with a payment, and `joined_month`. So it includes inactive months that have
  payments, months after a student left (Not applicable), and a future joining month.
- **Profile months (`months[]`)** also run to the latest month extra money pays, so a month
  paid ahead by another month's extra is listed.
- **Months after the current month** get the same status rule as any other (for example
  `paid` when paid ahead in full, `unpaid` when not), with `is_due: false`. They never count
  as owed and never appear in the dashboard's *Backlog*. What pays one (a payment logged for
  it, up to its fee, and extra money from other payments) adds to `paid_ahead_paise`. A payment
  logged for one pays that month only; its extra goes to the oldest month owed, like any
  other. All of it adds to the net `balance_paise`.
- **Dashboard `active_student_count`** ("from N students", "of N") counts students active in
  M **with a fee above ₹0 in M**: a month off, the months away before coming back, or a free
  place isn't counted. `expected_paise` and the lists are unchanged by that.
- **`status`** (PRD ledger rule 6) is `owes` if `owed_paise > 0`, else `credit` if
  `credit_paise > 0`, else `up_to_date` (`ledger.standing_status`). **`owed_paise`** is the
  sum of `remaining_paise` over due months (active months up to and including the current
  month), after credit allocation. **`paid_ahead_paise`** is what pays months after the
  current month (`Σ paid_direct + covered_by_credit` over them). **`credit_paise`** is money no
  month needed (`Σ extra_unused_paise`). So
  `total_paid = Σ (paid_direct + covered_by_credit) over due months + paid_ahead + credit`.
  **`balance_paise`** is the net `sum(payments) − sum(expected for due months)`; it is kept for
  reference, but the UI never uses it for a headline, because money paid ahead can cancel out
  a month still owed.
- **`credit_paise`** (PRD ledger rule 10) is only what's left once every payment has paid its
  own month and every month it could: every enrolled month with a fee up to `left_month` or 24
  months ahead is then paid. So a student who owes never has credit, and the dashboard's
  `yet_to_pay[].credit_paise` and `backlog[].credit_paise` are 0 in practice (kept so the shape
  didn't change).

- **`tenure_months`** is how long they have been (or were) a student. Still coming: whole
  months since joining, `current_month − joined_month` (joined in August, now September: 1; 0
  in the joining month and before it, when the UI says "New this month" or "Starts …"). Left
  (`left_month` before the current month): the months enrolled, both ends counted,
  `left_month − joined_month + 1` (March to June: 4; joined and left in May: 1).
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

### Credit allocation

PRD ledger rule 10 ("extra money covers unpaid months"), in `ledger.allocate`. It is **computed,
pure and deterministic, and never stored**: no table or column holds it, and no migration was
needed. A database written by v0.1.0 gives the new numbers as it is
(`tests/test_ledger_on_v0_1_0_data.py`).

For one student and the current month:

1. Take the payments in `(paid_on, id)` order.
2. **Pass 1.** Each payment pays its own `for_month`, up to what's left of that month's fee
   (`expected − already paid`). A month with `expected = 0` (before `joined_month`, after
   `left_month`, a ₹0 fee) takes nothing.
3. **Pass 2.** The **allocation months** are every enrolled month with a fee above ₹0, from
   `joined_month` to `left_month` or the current month + 24 (`MONTHS_AHEAD`), whichever is
   first, oldest first: so the due months come before the later ones. Each payment's leftover,
   in the same order, fills the oldest allocation month that isn't full yet, and so on.
4. Whatever is still left of a payment is its `extra_unused_paise`: credit.

What comes out (`MonthLine` / `LedgerMonth` per month, `PaymentUse` / `PaymentRead` per payment):

| Field | Meaning |
|---|---|
| `paid_direct_paise` | From payments logged for this month, up to its fee |
| `covered_by_credit_paise` | From other payments' leftovers (`credit_sources[]` says which) |
| `extra_sent[]` | Where this month's payments' leftovers went, per month (a payment: per month it paid) |
| `extra_unused_paise` | Leftover no month needed: credit |
| `status` | `month_status(expected, paid_direct + covered_by_credit + extra_unused)` |

Invariants (checked by property tests in `tests/test_allocation.py`):

- per payment: `amount = paid_direct + Σ extra_sent + extra_unused`;
- per month: `paid_direct + covered_by_credit + remaining = expected` and
  `paid = paid_direct + Σ extra_sent + extra_unused`; a month is never paid above its fee;
- in total: `Σ amount = Σ paid_direct + Σ covered_by_credit + credit`, and
  `Σ covered_by_credit = Σ extra_sent`;
- oldest first: a month paid by credit has every earlier allocation month fully paid;
- credit only once every allocation month is fully paid (so `owed = 0`);
- the order payments are listed in doesn't matter; another payment never makes anything more
  owed.

Which months end up paid depends only on how much was logged for each month and in total, not
on which payment it came from. The *Log payment* form previews a payment with a copy of the
same rule (`frontend/src/lib/allocation.ts`, `previewPayment`): it allocates the student's
payments with the new one added and shows what *that payment's own* money does (its
`paid_direct`, `extra_sent` and `extra_unused`), exactly as its row will say once saved.

**Needs a check.** `ledger.needs_check`: a payment that pays `CHECK_MONTHS_AHEAD` (4) or more
months after the current one (`ledger.months_ahead`: its own month if it paid any of it, and
where its extra went), or has money kept as credit (`extra_unused_paise > 0`, which covers
money logged for a ₹0-fee month when nothing is owed). Paying due months never flags.
Exposed as `PaymentRead.needs_check` / `months_ahead` and
`CreditMoveItem.payment_needs_check` / `payment_months_ahead` /
`payment_extra_unused_paise`, so every screen can give the reason. Extra money quietly pays
months ahead, so an extra zero would otherwise just look paid ahead.
