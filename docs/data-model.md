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
| `batch_label` | TEXT NULL | Free text typed before batches existed. Kept exactly as typed; "Create batches from existing labels" reads it and never changes it |
| `batch_id` | INTEGER NULL, FK → `batches` | The batch they're in, or none. Added by migration `0005` (every existing student starts in none). Indexed. See [`batches`](#batches) |
| `joined_month` | DATE NOT NULL | First month they owe |
| `left_month` | DATE NULL | Last month they owe. Once it has passed, the student is *Left* (archived) |
| `notes` | TEXT NULL | |
| `uid` | TEXT NULL, unique | A random id (32 hex letters) the student keeps across Excel downloads and uploads; given the first time they're in a *Download everything* file, and kept by a restore. Added by migration `0004` (a new nullable column and index: `ALTER TABLE ... ADD COLUMN`, no row changed). See [Excel](#excel-download-and-upload) |
| `created_at`, `updated_at` | DATETIME | |

### `batches`
A class students come to. Added by migration `0005`. A student is in one batch or none
(`students.batch_id`).

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT NOT NULL, `COLLATE NOCASE`, UNIQUE | Not blank. Unique ignoring capitals (the database, A–Z) and, checked by the API, ignoring accents and spaces too (`same_text_key`) |
| `location` | TEXT NULL | Free text |
| `days` | TEXT(7) NOT NULL, default `'0000000'` | One character per weekday, **Monday first**: `'1010000'` is Mon and Wed. `CHECK (length(days) = 7 AND days NOT GLOB '*[^01]*')`. The API sends a list (`["mon", "wed"]`) |
| `start_time`, `end_time` | TEXT(5) NULL | `"HH:MM"`, 24-hour, `00:00`–`23:59` (a CHECK). The API also checks the end is after the start |
| `default_fee_paise` | INTEGER NULL | The **usual monthly fee**: it only prefills a new student's fee. 0 to `MAX_AMOUNT_PAISE` (a CHECK) |
| `notes` | TEXT NULL | |
| `created_at`, `updated_at` | DATETIME | |

**Deleting a batch** never deletes a student. `students.batch_id` is declared
`REFERENCES batches (id) ON DELETE SET NULL`, and `services/batches.delete_batch` also sets it
to NULL itself before deleting the batch. (The column was added with a plain `ADD COLUMN`, so the
link is written inline; SQLite can't read an inline link's `ON DELETE` back, so a later table
rebuild could lose it. The app doesn't rely on it.)

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

### `unassigned_payments`
Payments from an uploaded Excel file whose student couldn't be matched (no student, or more
than one, fits the name or phone), kept as written until the owner assigns one (it then moves
into `payments`) or deletes it. Added by migration `0003`, which only adds this table: nothing
else changes, and `payments.student_id` stays `NOT NULL`. They belong to no student, so the
ledger never sees them: no student's or month's totals, and not *Collected*.

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `student_text` | TEXT NOT NULL | The student as written in the file (a name, or a phone number); not blank |
| `phone` | TEXT NULL | The file's phone column, if any |
| `amount_paise` | INTEGER NOT NULL | > 0 (capped like a payment by the upload) |
| `paid_on` | DATE NOT NULL | |
| `for_month` | DATE NOT NULL | |
| `method` | TEXT NOT NULL | `upi` / `cash` / `other` |
| `note` | TEXT NULL | |
| `source` | TEXT NULL | Where it came from, e.g. `Upload: october.xlsx` |
| `created_at` | DATETIME | |

### `feedback`
In-app feedback (Settings → Send feedback), saved here first and then sent to the feedback
relay by the server ([ADR 0005](adr/0005-feedback-is-the-only-outbound-call.md)). Not the
owner's records: nothing in the ledger reads it. Added by migration `0006` (a new table only).

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT(36) PK | A UUID made by the dialog when it opens: the idempotency key here and at the relay |
| `created_at` | DATETIME | UTC, set by the database |
| `category` | TEXT NOT NULL | `problem`, `idea` or `question` (CHECK) |
| `message` | TEXT NOT NULL | What the owner wrote; not blank (CHECK) |
| `route` | TEXT NULL | The page's path only, e.g. `/payments` (a query or `#` part is dropped: a search can be a name) |
| `diagnostics` | TEXT NOT NULL | JSON, see [Feedback](#feedback) below. Default `{}` |
| `screenshot_file` | TEXT NULL | The picture's file name in `<data folder>/feedback/` (`<id>.jpg` or `.png`) |
| `status` | TEXT NOT NULL | `pending` (default), `sent` or `failed` (CHECK) |
| `attempts` | INTEGER NOT NULL | How many times sending was tried (default 0, ≥ 0) |
| `last_error` | TEXT NULL | Why the last try failed, in words |
| `sent_at` | DATETIME NULL | UTC |
| `remote_ref` | TEXT NULL | The issue's URL in the private feedback repo |

Index: `feedback(status)`. The **picture is a file, not a column**, so the daily backups (30 of
them) stay small; it only exists until the feedback is sent, then it's deleted (the relay has
it). If it's gone before then, the rest is sent without it.

### Database safeguards

The database itself rejects bad rows, as a last line of defence behind the API's validation:

- Every month column holds a real **first-of-month date**:
  `CHECK (col IS date(col, 'start of month'))`. This rejects `'garbage'`, `'2026-10'`,
  `20261001` and `'2026-10-05'`. `paid_on` must be a real date (`paid_on IS date(paid_on)`).
- `students.left_month ≥ joined_month`, and `name` isn't blank.
- `batches.name` isn't blank and is unique (ignoring A–Z capitals); `days` is seven `0`/`1`
  characters; times are `HH:MM`; `default_fee_paise` is 0 to ₹10,00,000.
- `fee_changes.amount_paise ≥ 0`, and `(student_id, effective_month)` is unique.
- `payments.amount_paise > 0`, and `method` is one of `upi`, `cash`, `other`.
- `unassigned_payments` has the same checks as `payments` (amount, method, `for_month`,
  `paid_on`), and `student_text` isn't blank.
- Foreign keys are enforced (`PRAGMA foreign_keys=ON` on every connection), so deleting a student
  deletes their fee changes and payments.

Indexes: `students(name)`, `students(batch_id)`, `payments(student_id, for_month)`,
`payments(for_month)` and `payments(paid_on)`.

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
| `GET /students?status=active\|left\|all&q=&batch=&location=` | List of students, each with `monthly_fee_paise` (current fee), `status` (`owes` / `credit` / `up_to_date`), `owed_paise`, `credit_paise`, `paid_ahead_paise` (all three after [credit allocation](#credit-allocation)) and the net `balance_paise`. `active` (default) = not left yet (no `left_month`, or `left_month ≥` the current month); `left` = the left month has passed. `q` matches name, guardian or phone, ignoring case and accents (and spaces in phone numbers). `batch` is a batch id, or `none` for the students in no batch (anything else is a 422 on `["query", "batch"]`; an id that doesn't exist matches nobody). `location` keeps the students whose batch's location is the same ignoring case, accents and spaces. Sorted by name, ignoring case and accents |
| `POST /students` | Create. Body: `name`, `monthly_fee_paise`, `joined_month`, and optionally `phone`, `guardian_name`, `batch_label`, `batch_id`, `notes`, `left_month`. A `batch_id` that names no batch is a 422 on `batch_id` ("That batch doesn't exist any more. Choose another one, or No batch.") |
| `GET /students/{id}` | Detail, including `fee_history`, `months[]` (the ledger; see [Ledger computation](#ledger-computation)) and `payment_count` (so the UI can warn before a delete) |
| `PATCH /students/{id}` | Partial update. A new fee is sent as `monthly_fee_paise` + `fee_effective_month` (which defaults to the current month, or `joined_month` if that is later). `batch_id` moves them to a batch (`null`: no batch), checked as in `POST`. See the edit rules below |
| `DELETE /students/{id}` | Hard delete. Payments cascade |
| `POST /students/{id}/return` | A student who left comes again (PRD ledger rule 11). Body: `{from_month, monthly_fee_paise?}`; `from_month` is any month after `left_month` and at most 24 months ahead. In one transaction, holding the write lock: a ₹0 fee change at the month after `left_month` (none if `from_month` is that month), fee changes in the gap between them removed, every `'away'` row after `left_month` removed, `monthly_fee_paise` (default: `return_fee`, the latest `'fee'` row on or before `from_month`) recorded from `from_month`, and `left_month` cleared. Answers 200 with the `StudentDetail`. 422 on `from_month` if they haven't been marked as left, or the month is too early or too late. See [Coming back after leaving](#coming-back-after-leaving) |
| `DELETE /students/{id}/fee-changes/{fee_change_id}` | Remove a fee change that hasn't started yet (its month is after the current month); the fee before it carries on. 204. 404 if the student, or that fee change of theirs, doesn't exist. 422 (`loc: ["path", "fee_change_id"]`) for the first fee, one that has already started, or the fee they came back on (a `'fee'` row right after an `'away'` one: "This is the fee they came back on. To change it, set a new fee in Edit.") |
| `GET /payments?student_id=&month=&q=&sort=paid_on\|for_month\|amount\|student\|method&order=asc\|desc` | List, including `student_name` and where each payment's money went (`paid_direct_paise`, `extra_sent[]`, `extra_unused_paise`; see [Credit allocation](#credit-allocation)). Always three queries (students, fee changes, payments), however many rows. `month` matches `for_month`; `q` matches the student's name or the note, ignoring case and accents ("emile" finds "Émile"). `sort=student` sorts by name ignoring case and accents; `method` sorts `cash`, `other`, `upi`. Ties go to the latest `paid_on`, then the newest entry |
| `POST /payments` | Create. Body: `student_id`, `amount_paise`, `paid_on`, `for_month`, `method`, `note?`. 404 if the student doesn't exist. Any `for_month` within the [limits](#limits) is accepted, even one the student isn't active in (all of it is then extra, and pays the oldest month owed). Answers with the `PaymentRead`, including where its money went |
| `GET /payments/{id}` · `PATCH /payments/{id}` · `DELETE /payments/{id}` | `PATCH` may move a payment to another student (404 if that student doesn't exist). An edit or delete changes where that payment's extra goes at once (nothing is stored) |
| `GET /batches` | Every batch (`BatchRead`), sorted by name ignoring case and accents, with numbers in number order ("Batch 2" before "Batch 10") |
| `POST /batches` | Create. Body (`BatchCreate`): `name`, and optionally `location`, `days`, `start_time`, `end_time`, `default_fee_paise`, `notes`. 201. A name already used (ignoring case, accents and spaces) is a 422 on `name` |
| `GET /batches/{id}` · `PATCH /batches/{id}` · `DELETE /batches/{id}` | `PATCH` (`BatchUpdate`) is partial; `name` and `days` can't be `null`; the end time is checked against the stored start (and the other way round). A new `default_fee_paise` changes no student's fee, unless `apply_fee: {from_month, student_ids}` is sent with it: then each student listed gets the new fee from `from_month` (see [Batches](#batch-rules)), in the same transaction. `DELETE` answers 204; the batch's students are then in no batch |
| `GET /batches/summary?month=YYYY-MM` | `BatchOverview`: for each batch (in the order of `GET /batches`) and for the students in no batch, a `BatchSummary` for the month (default: the current month). See [Batches](#batch-rules) |
| `GET /batches/from-labels` | `LabelPreview`: what "Create batches from existing labels" would do. Changes nothing |
| `GET /batches/{id}/fee-plan?fee_paise=&from_month=` | `FeePlan`: what "Also charge the new usual fee" would do to each student of the batch, and who is ticked at first (`getFeePlan`). The same rule `PATCH … apply_fee` uses. See [Batch rules](#batch-rules) |
| `POST /batches/move` | `{student_ids, batch_id}` (`batch_id: null` for no batch): put them all in it at once, in one transaction; fees and labels don't change. 422 on `student_ids` if one doesn't exist, on `batch_id` if the batch doesn't. Answers `{moved}` (`moveStudents`) |
| `POST /batches/from-labels` | Do it (`LabelConversion`). Takes a `pre-batches` backup first (none if there's nothing to do); a failed backup is a 422 and nothing changes. Running it again does nothing |
| `GET /about` | Settings → About: `AboutResponse` (`version`, `build_id`, `data_dir`, `backup_dir`, `log_dir`, `feedback_sending`, `feedback_waiting`) |
| `POST /feedback` | Save feedback (`FeedbackCreate`), answer 201 with `FeedbackRead` at once, and wake the sender. Idempotent: the same `id` again answers with the row already saved, unchanged. See [Feedback](#feedback) |
| `GET /feedback/{feedback_id}` | `FeedbackRead`: whether it has been sent yet (the dialog polls it). 404 if unknown; 422 if not a UUID |
| `GET /dashboard?month=YYYY-MM` | See the PRD's "Dashboard for a selected month M" section. Returns `month`, `current_month`, `summary`, `yet_to_pay[]`, `backlog[]`, `overpaid[]` (months holding credit) and `credit_moves[]` |
| `GET /report?month=YYYY-MM` | The monthly report: one `ReportRow` per student relevant to the month, and `totals`. See [Monthly report](#monthly-report). `month` defaults to the current month |
| `GET /report.xlsx?month=YYYY-MM&status=&q=&sort=&order=&batch=&group=` | The report as the page shows it (`batch`: an id or `none`; `group=batch` puts each batch's rows under a heading row and ends them with a subtotal row of `SUBTOTAL(109, …)` formulas, batches A to Z, "No batch" last), as an Excel file (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`), a download named `scrappy-records-report-YYYY-MM.xlsx`. `status` is a `ReportFilter` (default `all`), `q` the search (as `lib/search.ts`: name, class or phone), `sort` a `ReportSort` and `order` `asc`/`desc` (ties keep the usual order): `services/report.shown`, the same rules as `frontend/src/lib/report.ts`. A title row (with the filter, search and sort in words), the date, frozen bold headings with Excel's filter buttons, one row per student in the screen's column order (money in rupees with the Indian-grouping formats `RUPEES` / `RUPEES_PAISE`), a bold totals row of `SUBTOTAL(109, …)` formulas, and a Collected line (a formula); A4 landscape, one page wide, when printed from Excel. `services/report_xlsx.py` (openpyxl) |
| `GET /export/students.xlsx?status=active\|left\|all&q=&batch=` | The Students page as shown (`batch`: the tab, an id or `none`), as an Excel file (`exportStudents`), with a Batch and an Old class label column. `q` uses the page's own search rules (`services/text.student_matches`, the Python twin of `lib/search.ts`), not the list endpoint's. See [Excel](#excel-download-and-upload) |
| `GET /export/payments.xlsx?student_id=&month=&q=&method=&sort=&order=` | The Payments page as shown: its filters (method included, which the list endpoint leaves to the UI) and the table's order (`exportPayments`) |
| `GET /export/everything.xlsx` | Every record in one workbook: Students (with each student's Batch), Batches (name, location, days as "Mon, Wed", starts, ends, usual fee, notes), Fee history, Payments and Unassigned payments, with each student's ID (`exportEverything`). Uploading it into an empty app restores everything, batches and each student's batch included |
| `GET /import/template.xlsx?kind=students\|payments` | A blank sheet to fill in, and a *How to fill this in* sheet the upload skips (`importTemplate`) |
| `POST /import/preview?filename=` | The `.xlsx` file itself as the body (at most 5 MB). Answers `ImportPreview`: what adding the file would do, with every row that needs a choice and the first rows of the rest, and counts for all. **Saves nothing.** A file that can't be read is a 422 with a plain message (`previewImport`) |
| `POST /import/commit` | `ImportCommit`: the same file again (base64) and the owner's choices, for only the rows she chose something for. The file is read and every row checked again against the records as they are now, a `pre-import` backup is taken (only if anything will be added), and it is all added in one transaction. Answers `ImportResult` (`commitImport`) |
| `GET /unassigned-payments` | Every unassigned payment, oldest paid first, each with `suggested_student_ids` (`listUnassignedPayments`) |
| `POST /unassigned-payments/{id}/assign` | Body `{student_id}`. In one transaction: the payment is added for that student and the unassigned row deleted. 201 with the `PaymentRead`. 422 on `student_id` if that student already has the same payment (amount, `paid_on`, `for_month`), or doesn't exist; 404 if the unassigned payment is gone (`assignUnassignedPayment`) |
| `DELETE /unassigned-payments/{id}` | 204; 404 if it's gone (`deleteUnassignedPayment`) |
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
| `StudentRead` (list item) | `id`, `name`, `phone`, `guardian_name`, `batch_label`, `batch_id`, `batch_name` (the batch's name, or `null`), `joined_month`, `left_month`, `notes`, `is_active`, `monthly_fee_paise`, `status` (see below), `owed_paise`, `credit_paise` (money no month needed), `paid_ahead_paise`, `balance_paise` (net, for reference only), `tenure_months`, `next_fee_change` (the first `FeeChangeRead` after the month `monthly_fee_paise` is for, or `null`), `current_month`, `created_at`, `updated_at` |
| `StudentDetail` (`GET`/`POST`/`PATCH` of one student) | `StudentRead`, plus `fee_history[]` (`FeeChangeRead`: `id`, `effective_month`, `amount_paise`, `kind`), `months[]` (`LedgerMonth`), `payment_count` and `total_paid_paise` |
| `LedgerMonth` | `month`, `expected_paise`, `paid_paise` (everything logged for the month, as typed), `paid_direct_paise` (the part of it that pays this month: at most the fee), `covered_by_credit_paise` (extra money from payments logged for other months that pays it), `credit_sources[]` (`CreditSource`: where that came from), `extra_sent[]` (`ExtraSent`: where this month's money above its fee went, one per month, oldest first), `extra_unused_paise` (this month's money no month needed: credit), `remaining_paise` (`max(0, expected − paid_direct − covered_by_credit)`), `excess_paise` (`max(0, paid − expected)` = Σ `extra_sent` + `extra_unused_paise`), `status`, `is_due` (month ≤ current month) |
| `CreditSource` | `payment_id`, `paid_on`, `for_month` (the month that payment was logged for), `amount_paise` (how much of it pays this month) |
| `ExtraSent` | `to_month`, `amount_paise` |
| `PaymentRead` | `id`, `student_id`, `student_name`, `amount_paise`, `paid_on`, `for_month`, `method`, `note`, `paid_direct_paise` (the part that pays `for_month`), `needs_check` (worth a glance in case of a typo: it pays 4 or more months ahead, or some of it is kept as credit; `ledger.needs_check`), `months_ahead` (how many months after the current one it pays), `extra_sent[]` (`ExtraSent`: the rest, paying other months, oldest first), `extra_unused_paise` (credit), `created_at`, `updated_at`. Always `amount = paid_direct + Σ extra_sent + extra_unused` |
| `DashboardResponse` | `month`, `summary` (`expected_paise`, `collected_paise` (what pays M: Σ `paid_direct + covered_by_credit` for M over every student), `paid_ahead_paise` (for a month after the current one, the same as `collected_paise`; 0 otherwise), `still_due_paise`, `not_fully_paid_count`, `active_student_count`, `logged_paise` (every payment logged for M, as typed: the Payments page's total for M), `covered_by_credit_paise` (the part of `collected_paise` from other months' payments), `sent_elsewhere_paise` (the part of `logged_paise` that paid other months)), `current_month`, `yet_to_pay[]` (each with `paid_paise`, `covered_by_credit_paise` and `credit_paise`), `backlog[]` (each with `months[]` (`BacklogMonth`, with `covered_by_credit_paise`), `total_owed_paise` and `credit_paise`), `overpaid[]` (`OverpaidItem`: months holding credit, with `batch_label`, `batch_name`, `phone`, `excess_paise` and `extra_unused_paise`) and `credit_moves[]` (`CreditMoveItem`) |
| `CreditMoveItem` | Extra money moved into or out of M: `student_id`, `student_name`, `batch_label`, `batch_name`, `phone`, `payment_id`, `paid_on`, `from_month` (the month the payment was logged for), `to_month` (the month it pays), `amount_paise`, `payment_amount_paise` (the whole payment), `payment_pays_until` (the latest month the payment pays: `ledger.pays_until`), `payment_needs_check`, `payment_months_ahead`, `payment_extra_unused_paise` (so the check can say why). One per payment and month (the UI groups them by payment); one of the two months is M. Sorted by student name, then `to_month`, then the payment's `(paid_on, id)` |
| `ReportResponse` | `month`, `current_month`, `today` (the server's date, printed on the report), `rows[]` (`ReportRow`, in `ReportStatus` order, then by name ignoring case and accents), `totals` (`ReportTotals`), `unassigned_count` and `unassigned_paise` (unassigned payments for M: in no row or total, so the report adds a line saying so, and its Excel file a note under the totals) |
| `ReportRow` | `student_id`, `student_name`, `batch_label`, `batch_name`, `batch_id`, `phone`, `joined_month`, `left_month`, `is_enrolled` (active in M), `status` (`ReportStatus`), `no_fee_reason` (`NoFeeReason`, only for `no_fee`), `checks[]` (`ReportCheck`: payments logged for M that `ledger.needs_check` flags, with `payment_id`, `paid_on`, `amount_paise`, `pays_until`, `months_ahead`, `extra_unused_paise`, as on the dashboard); for M, the student's `LedgerMonth` fields: `fee_paise` (`expected_paise`), `paid_paise` (logged for M, as typed), `paid_direct_paise`, `covered_by_credit_paise` with `credit_sources[]`, `extra_sent_paise` (Σ `extra_sent`) with `extra_sent[]`, `extra_unused_paise`, `short_paise` (`remaining_paise`); `owed_before_paise` and `owed_before_months[]` (due months before M still Unpaid or Partial: the dashboard's `backlog` entry); and, as of the current month, `owed_now_paise`, `credit_paise`, `paid_ahead_paise` (the `StudentRead` values) |
| `ReportTotals` | `student_count` and the sums of every row's money fields, plus `collected_paise` (Σ `paid_direct + covered_by_credit`), `not_fully_paid_count` (rows with `short_paise > 0`) and `active_student_count` (rows enrolled in M with a fee above 0). They are the dashboard summary for M: `fee_paise` = `expected_paise`, `paid_paise` = `logged_paise`, `extra_sent_paise` = `sent_elsewhere_paise`, `short_paise` = `still_due_paise`, and `collected_paise`, `covered_by_credit_paise` and the two counts are the same |
| `SuggestedPayment` | `for_month` (nullable), `amount_paise` (nullable), `reason` |
| `StudentReturn` (request) | `from_month`, `monthly_fee_paise` (optional) |
| `UnassignedPaymentRead` | `id`, `student_text`, `phone`, `amount_paise`, `paid_on`, `for_month`, `method`, `note`, `source`, `created_at`, `suggested_student_ids` (same name or phone first, then whoever the Students search finds for the name as written; at most 5) |
| `UnassignedAssign` (request) | `student_id` |
| `ImportPreview` | `filename`, `sheets` (read), `ignored_sheets`, `hidden_sheets`, `students[]` (`ImportStudentPreview`), `payments[]` (`ImportPaymentPreview`), `student_counts` and `payment_counts` (rows by status, all of them), `all_rows_shown` (false when rows that need no choice were only counted), `fee_changes` (fee-history rows restored with the new students), `current_month`,
`file_sha256` (of the file read, for Add). Every `similar`, `needs_student`, `follows_student` and `possible_duplicate` row is listed; of each other status the first 100 (problems: 1,000) |
| `ImportStudentPreview` | `row`, `sheet`, `name`, `phone`, `monthly_fee_paise`, `joined_month`, `status`, `reason` (plain words), `student_id` (the student already here it is, or looks like), `add_by_default` (a `similar` row added unless skipped) |
| `ImportPaymentPreview` | `row`, `sheet`, `student_text`, `amount_paise`, `paid_on`, `for_month`, `method`, `note`, `status`, `reason`, `student_id` (an existing student it goes to), `student_row` (a student in the same file it goes to), `candidate_ids` (who it may be) |
| `ImportCommit` (request) | `file` (the .xlsx, base64), `file_sha256` (the preview's), `filename`, `students[]` (`{row, add}`: `add: true` adds a `similar` row, `false` skips any row), `payments[]` (`{sheet, row, choice, student_id?}`), `create_batches[]` (names of `not_found` batches to create; any other name is a 422 on `create_batches`). Rows not mentioned do what their status says; rows that aren't in the file are ignored |
| `ImportResult` | `students_added`, `fee_changes_added`, `payments_added`, `unassigned_added`, `skipped` (rows sent but not added), `backup_file` (the `records-pre-import-…` file, or `null` when nothing was added), `batches_added` |
| `ImportBatchPreview` | `name`, `status` (`ImportBatchStatus`: `new` (on the file's Batches sheet, not here: added with its details), `exists` (same name here, ignoring case, accents and spaces: its students go into it; it isn't changed), `not_found` (only in the students' Batch column: "Batch not found, will be left without a batch"; the name is kept in their `batch_label`, joined with " · " to any old label the row has, unless `create_batches` names it), `problem`), `reason`, `row` (on the Batches sheet), `student_count` (rows naming it that will be added; a `not_found` batch is only created if one of the rows actually added names it), `batch_id`. Names match by `imports.batch_key`: ignoring case, accents, spaces and punctuation |
| `BatchRead` | `id`, `name`, `location`, `days[]` (`Weekday`, Monday first), `start_time`, `end_time` (`"HH:MM"` or `null`), `default_fee_paise`, `notes`, `student_count` (everyone in it, those who left included), `active_student_count` (those not left yet), `created_at`, `updated_at` |
| `BatchCreate` / `BatchUpdate` (requests) | The fields above that can be typed, plus on `BatchUpdate` `apply_fee` (`ApplyBatchFee`: `from_month`, `student_ids[]`, `confirm_planned[]`) |
| `BatchSummary` | `batch_id` (`null` for no batch), `student_count` (in it and active in M), `active_student_count` (of those, with a fee above 0 in M, as the Dashboard counts), `expected_paise`, `collected_paise`, `still_due_paise`, `paid_ahead_paise`, `not_fully_paid_count`, `paid_percent` (0–100, rounded down; `null` when nothing is expected) |
| `BatchOverview` | `month`, `current_month`, `batches[]` (`BatchSummary`), `no_batch` (`BatchSummary`) |
| `LabelPreview` | `groups[]` (`LabelGroup`: `name`, `labels[]` (the spellings, most used first), `student_count`, `student_names[]`, `left_student_names[]` (those who have left), `active_student_count`, `existing_batch_id`), `student_count`, `new_batch_count` |
| `LabelConversion` | `batches_created`, `students_placed`, `backup_file` (the backup's file name, or `null`) |
| `FeePlan` | `batch_id`, `fee_paise`, `from_month`, `current_month`, `usual_fee_paise` (the batch's usual fee, or the most common one if it has none; `null` on a tie), `students[]` (`FeePlanStudent`: `student_id`, `student_name`, `current_fee_paise`, `start_month` (null if they leave before it), `status` (`FeePlanStatus`: `usual`, `own_fee`, `planned`, `already`, `not_affected`), `selected` (ticked at first: `usual`), `due_months` and `due_change_paise` (months already due whose fee would change, and how much more they'd owe; negative for less), `fee_history[]`) |
| `HealthResponse` | `app`, `version`, `status` |
| `AboutResponse` | `version`, `build_id` (the git commit the app was built from, or `unknown`), `data_dir`, `backup_dir` (the fallback `data/backups` if Documents couldn't be used), `log_dir`, `feedback_sending` (a relay URL is set), `feedback_waiting` (pending count) |
| `FeedbackCreate` (request) | `id` (UUID, optional: made by the server if absent), `category`, `message` (1–5,000 characters after trimming; "Please write a message"), `route` (≤ 500, cut), `client` (`FeedbackClientInfo`), `screenshot` (base64 or a `data:` URL of a JPEG or PNG, ≤ 700,000 bytes; else 422 "The picture of the screen is too big to send" / "couldn't be read"; `null` for none) |
| `FeedbackClientInfo` | `local_time`, `timezone`, `language`, `user_agent`, `screen`, `window`, `ui_build`, `errors[]` (`FeedbackClientError`: `at`, `kind`, `message`; the last 20 kept). Best effort: too-long text is cut and unsavable characters become `?`, never a 422 |
| `FeedbackRead` | `id`, `category`, `status`, `created_at`, `sent_at`, `attempts`, `sending` (this copy is trying to send it) |

**Enums.**
- `MonthStatus`: `paid`, `partial`, `unpaid`, `overpaid`, `not_applicable`, from what pays the
  month (see [Credit allocation](#credit-allocation)). **Paid with credit** isn't a separate
  value: it is `paid` with `covered_by_credit_paise > 0`. `overpaid` means some of the month's
  own money is credit (`extra_unused_paise > 0`).
- `BalanceStatus`: `up_to_date`, `owes`, `credit`.
- `ReportStatus` (the monthly report, in its order): `unpaid`, `partial`, `not_due_yet`,
  `paid_with_credit` (shown as **Paid (from extra)**), `paid`, `no_fee`, `left`. See
  [Monthly report](#monthly-report).
- `NoFeeReason`: `not_joined`, `away` (the fee in effect is an `away` row), `zero_fee`.
- `ReportFilter` (the report's status list): `all`, `owes` (for the current month or a later
  one `owed_now_paise > 0`; for a past month `owed_before_paise + short_paise > 0`, owed today
  for that month or earlier: `report.owes_through_month`, shown as "Still owes for Aug 2026 or
  earlier"), `short`
  (`short_paise > 0`), or a `ReportStatus`.
- `ReportSort`: `student`, `status`, `fee`, `paid`, `short`, `owed_now`, `covered`, `extra`,
  `owed_before`, `credit`, `batch`.
- `SuggestionReason`: `owed`, `next_unpaid`, `all_paid`.
- `PaymentMethod`: `upi`, `cash`, `other`.
- `FeeKind`: `fee`, `away`.
- `ImportStudentStatus`: `new`, `exists`, `similar`, `problem`.
- `ImportPaymentStatus`: `ready`, `needs_student`, `follows_student`, `unassigned`, `duplicate`,
  `possible_duplicate`, `problem`.
- `ImportPaymentChoice`: `auto` (what the status says), `student` (with `student_id`),
  `unassigned`, `skip`, `add` (add anyway, though it looks like a duplicate).
- `ExportTemplateKind`: `students`, `payments`.
- `Weekday`: `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun`.
- `FeePlanStatus`: `usual`, `own_fee`, `planned`, `already`, `not_affected`.
- `ImportBatchStatus`: `new`, `exists`, `not_found`, `problem`.
- `ReportGroup`: `none`, `batch`.
- `FeedbackCategory`: `problem`, `idea`, `question`. `FeedbackStatus`: `pending`, `sent`,
  `failed`.

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

### Batch rules

`services/batches.py`, PRD [Batches](product/prd.md#batches).

- **Month numbers.** `overview` loads every student once (as the Dashboard does), splits them
  by `batch_id`, and runs `ledger.build_dashboard` over each group, so a `BatchSummary` is the
  Dashboard's summary over that batch's students. `student_count` is the students active in M
  (`StudentRecord.is_active`), whatever their fee. `paid_percent =
  (expected − still_due) × 100 // expected`. Because the groups split the students, every
  summed field over `batches[]` plus `no_batch` equals the Dashboard's
  (`tests/test_api_batches.py::test_batches_add_up_to_the_dashboard`). The batch is the one each
  student is in now: batch history isn't stored.
- **Applying a new usual fee.** One rule, `_plans`, behind both `fee_plan` (the preview,
  `GET /batches/{id}/fee-plan`) and `update_batch` → `_apply_fee`. For each student of the batch
  who hasn't left: the start month is `max(from_month, joined_month)`, none if their
  `left_month` is before it (`not_affected`), and if the fee in effect then is an `'away'` row,
  the next `'fee'` row's month (the month they came back). Status: `planned` if a fee change
  of theirs after the first is on or after the start month, or after the current month
  (`_own_changes`: a discount or month off set earlier, the fee they came back on, a planned
  change); else, their fee is the same in every month from the start month on, and it's
  `already` if that is the new fee, `usual` if it is the usual one (the batch's old
  `default_fee_paise`, or the most common such fee among them, none on a tie), else
  `own_fee`. `_apply_fee` checks every id is in the batch (else a 422 on `apply_fee`, nothing
  saved), refuses a `planned` student not also in `confirm_planned` (422, nothing saved), skips
  `already` and `not_affected`, and calls `students.set_fee_from` from the start month, exactly
  as a fee change in `PATCH /students/{id}`. `from_month` is at most 24 months ahead (422 on
  `["body", "apply_fee", "from_month"]`). The mock API (`mocks/db.ts` `feePlan`) mirrors it.
- **Moving many** (`move_students`): holds the write lock, checks the batch and every student,
  sets `batch_id` on all of them, one commit.
- **Labels to batches** (`label_preview`, `convert_labels`). Students with `batch_id IS NULL`
  and a non-blank `batch_label`, grouped by `same_text_key(batch_label)` (folded case and
  accents, no whitespace). A group's name is its most used spelling (whitespace collapsed; ties
  alphabetically), or the name of the existing batch with the same key, which it then joins.
  `convert_labels` holds the write lock, works the groups out again, takes a `pre-batches`
  backup (`app.backup`), creates the batches and sets `batch_id`, and commits once.
  `batch_label` is never written.
- **Names** are compared with `same_text_key` too, so "Tue/Thu 5pm" and "tue/thu  5PM" can't
  both exist.

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

## Excel download and upload

The code is in `services/exports.py` (downloads), `services/spreadsheet.py` (reading a file) and
`services/imports.py` (preview and add); `openpyxl` reads and writes the files.

**Downloads.** Real Excel dates for *Paid on* (`d mmm yyyy`), months as real first-of-month
dates shown as `mmm yyyy` (so they sort, and read back exactly whatever the spreadsheet app does
to them), money in rupees with a ₹ format, bold frozen headings, and text cells kept as text
(a note starting with `=` is never a formula). File names are
`scrappy-records-<students|payments|everything>-YYYY-MM-DD.xlsx`. *Download everything* adds a
grey **Student ID (for restoring)** column to the Students, Fee history and Payments sheets:
each student's `uid` (given to anyone who hasn't one yet, when the file is made). It links the
sheets, and finds the same students again when the file is uploaded, into this app or any
other; a restore gives each new student the uid from the file.

**Reading a file.** At most 5 MB, and a zip that unpacks to at most 80 MB; 5,000 rows a sheet
for a list someone made. A sheet with the Student ID column (a Download everything file) is
limited only by the file size (a sanity cap of 300,000 rows): a 3,000-student, 96,000-payment
file (3 MB) previews in about 5 s and adds in about 6 s. The size a file claims for a sheet is
ignored (`reset_dimensions`: a stale one would drop rows), hidden sheets are skipped and listed
in `hidden_sheets`, and a merged range's value counts in every cell it covers (only its first
64 columns, and only the rows the sheet really has, so a huge merge costs nothing).
Anything else (not `.xlsx`, an old `.xls`, damaged, password-protected, no recognisable
headings) is a 422 with a plain message; never a 500. A sheet's kind comes from its name (the
app's own: *Students*, *Fee history*, *Payments*, *Unassigned payments*) or its headings, found
in the first 10 rows (a sheet with an amount or method heading, or a date heading and no phone
column, is tried as payments first, where *Fee(s)* is the amount; *Name, Mobile, Fee, Date* is
students), ignoring case, punctuation, `₹` and anything in brackets: *Name* or
*Student*; *Fee* or *Monthly fee*; *Amount*; *Date* or *Paid on*; *Month* or *For month*;
*Phone*/*Mobile*; *Parent*/*Guardian*; *Class*/*Batch*; *Method*/*Mode*; *Note(s)*/*Remarks*.
One sheet of each kind is read; the rest are listed in `ignored_sheets`. Cells:

- Dates: date cells, Excel day numbers (also as text: `46300`), `5 Oct 2026`, `05/10/2026`
  (day first, as in India; a time after it is ignored), `5-10-26`, `2026-10-05`.
- Months: date cells (their month), `Oct 2026`, `October 2026`, `Oct-26`, `2026-10`, `10/2026`,
  `10/26`.
  A payment with no month counts for the month it was paid in; a student with no joined month
  joins this month.
- Money: numbers, `₹1,500`, `1500/-`, `Rs. 1,50,000.00`. Negative amounts, text, more than
  two decimals, and two numbers in one cell (`₹500 700`) are problems.
- Method: UPI (also GPay, PhonePe, Paytm, BHIM), Cash, or Other for anything else, blank
  included.

Every row is then checked with the same rules as typing it in: the `StudentCreate` /
`PaymentCreate` field rules (lengths, the ₹10,00,000 cap, characters that can't be saved) and
the [limits](#limits). A row that breaks one is a **problem**, with the row number and a plain
reason, and is skipped.

**Students** are matched with the shared search rules (`services/text.py`,
`services/matching.py`, all through indexes, so thousands of rows take seconds): names are the
same when they have the same words, in any order, ignoring capitals, accents and apostrophes (a
hyphen separates words); phones when they have the same digits (without `+91`). `exists`: same
name and phone, or same name and neither has a phone, or the same as an earlier row. `similar`:
same name with a different phone (or one of them has none), the same phone with a different
name, a name a letter apart (5–9 letters) or two apart (10 or more), a shortened name (*Ananya
R* and *Ananya Rao*: the same number of words, one the same, the others the start of their
partner), or more than one student here with the row's name and phone (one is never picked
silently); a second row with the same name as an earlier one where neither has a phone is
`similar` too (perhaps two people). All skipped unless the owner picks *Add as new*, except the
same phone as an earlier row of the file only (siblings), which is added unless she skips it
(`add_by_default`). Otherwise `new`. Nothing already here is ever changed.

**Student IDs.** Rows of a Download everything file carry the student's `uid`. A student here
with that uid is that row (`exists`) only if the row's name is theirs and its phone, where both
have one, agrees: in this app or one the file was restored into. Otherwise (a row copied in
Excel with a new name typed over it, a crafted row, or a phone changed since) the row is
`similar` to them: *Skip*, or *Add as new*, which gives the new student a uid of their own. The
same ID on two rows of the file with different names is handled the same way. The database's
own ids are never used, so a restore where they came out different changes nothing. Two rows
with different IDs are different people, so rows are never compared with each other (two
*Priya S* with no phone, or siblings sharing a phone, stay apart). A row whose ID nobody here has
is matched by name and phone as usual, each student here being one ID'd row at most. Payments
and fee history link to their student by ID, but a payment follows its ID only when its own
name (and phone) agree with that student's row; if not, it `needs_student`, and nothing is ever
added to a student on the strength of an ID alone. Uids are given with one `UPDATE ... WHERE uid
IS NULL`, so two downloads at the same moment can't give a student two.

**Payments** go to the student named: through the file's Student ID first (a Download
everything file), else by name and phone among the students here and the `new`/`similar` ones in
the same file. It goes to a student by itself only when the name matches (the same name and
phone beats a name-only match; the same name with a different phone is no match), or when the
row has only a phone number and it's theirs. The same phone under another name is
`needs_student`, with that student offered first. One match: `ready` (or `follows_student` when
it's a `similar` row in the file: it goes to them only if they're added, else it's kept
unassigned). None, or more than one: `needs_student`, kept as unassigned unless the owner picks
a student or skips it.

**Duplicates** are counted one for one against where each payment is going (a student here, a
new one, or unassigned by name as written): `duplicate` when a payment there has the same
amount, `paid_on`, `for_month`, method and note; `possible_duplicate` when only the method or
note differ. The same for an earlier row of the file, except that rows linked by Student ID are
never duplicates of each other (a restore brings back two identical instalments). A payment
whose student is a `similar` row, or that matches more than one student, is also checked
against the payments of the students here it may be, so an older download uploaded after an
edit adds nothing, not even unassigned payments. Both kinds are skipped unless the owner
chooses **Add anyway** (`choice: "add"`).

**Fee history** (a Download everything file) comes with each `new` student and is restored
exactly, months away included; it must start at the joined month, have one fee a month, and no
fee for a month away (else the student is a problem). An existing student's fee history is left
alone. Without one, a new student gets their *Monthly fee* from their joined month.

**Adding** (`POST /import/commit`) never trusts the preview: the browser sends the very bytes it
previewed (read once, never from disk again) as base64, with the preview's `file_sha256` and only
the choices the owner made. A body over 8 MB is refused before it's read (`app/limits.py`); a
file whose SHA-256 isn't the preview's is a 422 ("The file changed since you previewed it"); a
choice for a row or sheet that isn't in the file is a 422; and no 422 from this endpoint echoes
what was sent. Then the server takes the write lock, reads the
file and the records again, re-checks every row, re-classifies, applies the choices (a choice
can't add an `exists` or `problem` row; a chosen student who no longer exists means *keep as
unassigned*), re-checks duplicates, takes the `pre-import` backup (a failed backup is a 422 and
nothing is added), and adds everything in one transaction (payments in bulk). Any error rolls
all of it back. Sending the file again, rather than keeping it on the server between the two
steps, keeps the server stateless: nothing to expire or clean up, and a restart in between
changes nothing.

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

Unassigned payments (`unassigned_payments`) belong to no student, so none of this counts them.

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

### Monthly report

`GET /report?month=M`, from `ledger.build_report`: the same `month_line` (the profile's
`LedgerMonth` for M) as every other screen, never the dashboard's `credit_moves`, so the report
always reconciles with the dashboard and the profiles (`tests/test_report.py`
`assert_reconciles` checks every row and total, for many months, including on the demo data).

- **Who is on it:** every student enrolled in M (`is_active(M)`, a ₹0 fee included), or with
  money logged for M (`paid_paise > 0`), or extra money paying M
  (`covered_by_credit_paise > 0`), or still owing a due month before M (the dashboard's
  `backlog`, which includes students who have since left), or holding credit in M or an
  earlier month (`extra_unused_paise > 0` there: the dashboard's `overpaid` for M), or, when M
  is the current month or later, with any `credit_paise` or `paid_ahead_paise`. So the current
  month's `owed_now_paise`, `credit_paise` and `paid_ahead_paise` totals are the students
  list's sums (tested).
- **`status`** (`ledger.report_status`): not enrolled in M → `left` if M is after
  `left_month`, else `no_fee` (before `joined_month`); a ₹0 fee → `no_fee`; `remaining = 0` →
  `paid_with_credit` if `covered_by_credit > 0`, else `paid` (for a later month: paid ahead);
  otherwise a month after the current one → `not_due_yet`; otherwise `unpaid` (nothing pays
  it) or `partial`.
- **Order:** `ReportStatus` order (unpaid first), then name ignoring case and accents, then id.
- **Totals:** the sums of the rows. The UI's totals row sums the rows shown (`lib/report.ts`
  `sumRows`), the same numbers when nothing is filtered. Collected = `paid − extra_sent −
  extra_unused + covered_by_credit` = Σ `paid_direct + covered_by_credit`.
- **`checks`:** each payment logged for M with `ledger.needs_check` (pays 4 or more months
  ahead, or has money kept as credit), as the dashboard's `payment_needs_check`.

## Feedback

What **Send feedback** stores and sends ([ADR 0005](adr/0005-feedback-is-the-only-outbound-call.md),
[architecture](architecture.md#feedback)).

**`diagnostics`** (JSON text in the `feedback` row), assembled when it's saved:

| Key | From | What |
|---|---|---|
| `install_id` | server | A random UUID for this copy of the app, made once in `<data folder>/install-id` |
| `server` | server | `app_version`, `build_id`, `os`, `machine`, `python`, `db_revision`, `server_time` (local, with offset), `server_timezone` |
| `client` | browser | `FeedbackClientInfo`: local time, time zone, language, user agent, screen and window size, the UI's build, and its last 20 errors (script errors, unhandled rejections, failed API calls as "GET /api/students → 500": method, path and status, no query or body). The error messages go through `redact()` too |
| `log_tail` | server | The last 200 lines worth sending from `server.log` (and `server.log.1`): WARNING and above with their tracebacks, and the app's own (`scrappy`) notes; other libraries' INFO lines are left out. Each ≤ 500 characters, ≤ 64 KB in all. An exception raised in the app's own code (the traceback's last frame is in `app/`) keeps only its type and where it happened (`ValueError: [message left out: raised by the app]`), since its message could quote a student unquoted; a library's or the system's message is kept, redacted. `redact()`: escapes are decoded first (`\u0101`, `\xc4\x81`, `%C4%81`, and accents normalised), then the home folder in any spelling (`\`, `\\`, `/`, any case, only as a whole folder name) becomes `~`, any `Users\<name>` / `/home/<name>` folder (8.3 short names too) becomes `<user>`, and the user's name as a whole word (4 characters or more) becomes `<user>`. Quoted values become `'…'` (traceback `File "…"` lines keep their redacted path), and `[parameters: …]` becomes `[parameters: hidden]` |

Never included: the database, its rows, backups or exports. `tests/test_feedback.py` stores
distinctive names, phones, notes and amounts, logs a database error carrying them, and checks
none appears in the stored diagnostics or in what is sent.

**What the relay receives** (`services/feedback.relay_payload`, JSON, `POST` to
`config.feedback_url()`): `schema` (1), `id`, `install_id`, `category`, `message`, `created_at`
(UTC, `Z`), `local_time`, `app_version`, `build_id`, `route`, `environment` (`os`, `machine`,
`python`, `db_revision`, `server_timezone`, `browser`, `screen`, `window`, `timezone`,
`language`, `ui_build`), `errors[]`, `log_tail`, `screenshot` (`{content_type, data_base64}` or
`null`). `route` is the path only. The app keeps it under 2,000,000 bytes (the relay takes 2
MiB): the log is trimmed first, then the errors, then the picture. The relay answers
`201`/`200 {status: "created", issue_url}` (a retry of the same `id` gets the same URL). Only a
body with `status` `invalid` (400) or `blocked` (403) is final (`failed`, picture deleted);
`too_large` (413) gets one slimmer try (no picture, the last 50 log lines), then is final. After 3 failed tries of one item (errors, timeouts, broken connections; not just being offline) the next tries go without the picture, in case it's what pushes the relay past its CPU limit.
Everything else is retried later, honouring `Retry-After`: `409 in_progress`, `429
rate_limited` (up to a day for the global cap), `502`, `503 unavailable` / `misconfigured`,
other statuses and network errors. The app's timeout (90 s) is longer than the relay's 40 s
budget. The relay's own checks are in `relay/src/validate.ts`.
