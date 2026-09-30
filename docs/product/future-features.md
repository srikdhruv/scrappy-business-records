# Future features

Everything here was discussed and is intentionally **out of the MVP**. The MVP is kept thin so
the infrastructure (install, run locally, persist) is solid first. Items are grouped by theme and
roughly ordered by expected value within each group.

When picking one up, write a short spec in `docs/product/` and link it here.

---

## 1. Business structure: locations → batches → students

The owner runs several **locations**. Each has several **batches** (a day/time slot, sometimes
taught by a hired instructor), and each batch has several students.

- `locations`: name, address.
- `batches`: location, name, days of the week, start and end time, instructor, standard monthly
  fee.
- `enrollments`: student ↔ batch, start and end month, optional **per-student fee override**
  (discounts, siblings).
- A student in two batches owes both fees.
- Filter the dashboard and grid by location and batch. Group "Yet to pay" by location, then
  batch.
- **"Excused / on break" months:** mark a student as not owing for a specific month (holiday,
  injury) without archiving them. A cheap first version could reuse what *Mark as coming
  again* already does (PRD ledger rule 11, `POST /students/{id}/return`): a ₹0 fee change for
  the first month away and their fee again from the month they're back, in one step. A
  "Taking a break" button would ask for the months off and write exactly those two fee
  changes; the profile would then show those months as "On a break" rather than "No fee".
  Until then, the guide's month-off steps do the same by hand with two fee changes.
- **Migration path from the MVP:**
  - Each student's free-text `batch_label` becomes a suggestion when creating batches.
  - `students.monthly_fee` history maps to an enrollment fee override.

## 2. Month-by-month grid

- Students down the side, months across the top.
- Each cell is coloured Paid / Partial / Due / Excused / Paid ahead. Click a cell to log or see
  payments.
- Filter by location, batch and status.

## 2b. Smarter handling of extra money

**Built** (PRD ledger rule 10, "credit allocation"): extra money automatically covers the
oldest unpaid months, then later months ahead. It's worked out every time, not stored, so
payments stay exactly as typed, and every screen says where the money went.

Still open:

- **Offer to split:** when the amount is more than that month's fee, the form offers "Split
  ₹3,000 across August and September?" and records one payment per month. Probably not needed
  now; it would need `payment_allocations` (see §3).
- **Choose where it goes:** let the owner send one payment's extra to a particular month
  instead of the oldest one owed.
- **Say when a new payment moves another payment's extra.** Logging a payment for a month that
  another payment's extra already paid pays that month directly, so the older extra moves on
  (usually to a later month). The *Log payment* preview only describes the new payment's own
  money; it could add "the ₹1,500 from the 5 Sep payment will then pay October instead".
- **Show part-paid months inside ranges.** Notes and the Dashboard collapse months in a row into
  a range ("Oct 2026 to Sep 2028") without saying that the last one is only partly paid; the
  range could say so ("…, Sep 2028 in part").

## 3. Bank statement import (Excel/CSV)

Most payments arrive over **UPI**. Instead of typing each one:

1. The owner downloads a statement from their bank as Excel or CSV and drops it into the app.
2. The parser detects the header row and the date, narration, credit and reference columns, using
   **per-bank profiles** (SBI, HDFC, ICICI, Axis, Kotak…). It keeps credits only.
3. It parses the UPI narration (e.g. `UPI/CR/412345678901/RAMESH KUMAR/SBIN/ramesh@okaxis/…`) to
   extract the **payer name, VPA and UTR**.
4. It **deduplicates** by UTR, or by a hash of (date, amount, narration), so re-importing an
   overlapping statement is safe.
5. It **auto-matches** each payment to a student:
   - A known payer alias (VPA or name previously confirmed for this student) is a high-confidence
     match.
   - A fuzzy name match (rapidfuzz) with an amount equal to the expected fee is a medium match,
     confirmed with one click.
   - Anything else goes to a **"Who is this?"** queue. When the owner picks a student, the alias is
     remembered, so next month it matches automatically.
6. **Allocation:**
   - The default is the student's oldest unpaid month.
   - A payment worth several months' fees splits across them.
   - She can override any allocation.
7. **Preview before saving.** Nothing is recorded until the owner confirms.

This requires a `payment_allocations` table (a payment can cover several months) and
`payer_aliases`.

## 4. Automatic bank data (research)

"Automatic bank data" means payments reach the app without the owner downloading a statement. This
needs research before any build, with the owner's explicit consent.

- **Browser automation** of the owner's net-banking login (Playwright), with credentials in Windows
  Credential Manager (`keyring`).
  - Risks: OTP or 2FA on every login, bank terms of service, and fragile page selectors.
  - Probably limited to "log in, and the owner types the OTP".
- **Emailed statements or alerts.** Many banks email monthly statements (often password-protected
  PDFs) or per-transaction alerts. We could parse them from a mailbox via IMAP or the Gmail API.
- **UPI app exports.** GPay, PhonePe and Paytm business exports, if available.
- **Account Aggregator (RBI AA framework).** The "proper" API route, but it requires a licensed
  FIU. Not feasible for us.
- **Watch the Downloads folder.** Auto-detect a new statement file and offer to import it.

## 5. Notifications (to the owner only)

- **Windows toast notifications**, e.g. on the 5th of each month: "6 students haven't paid for
  October".
- An in-app summary banner when the app opens.
- A configurable schedule. This needs the app, or a tiny scheduler, to run at login (see §9).

## 6. Reminders to parents (optional, later)

In the MVP, reminders go to the owner only. If wanted later:

- **WhatsApp click-to-send.** A button opens WhatsApp with the parent's number and a prefilled
  message ("Hi, a gentle reminder that the October fee of ₹1,500 is pending…"). She presses Send.
  Free, and needs no account setup.
- **Fully automatic WhatsApp** via the WhatsApp Business Cloud API. Needs a Meta business account,
  approved templates and per-message cost, plus a small always-on hosted component.
- A reminder log per student, so the owner doesn't send twice.

## 7. Attendance and analytics

- Per-session attendance: pick a batch and date, tick who came.
- Attendance rate per student and per batch, and "hasn't attended in 3 weeks" flags.
- Collection trends (expected vs collected per month) and revenue per location or batch.
- Retention and tenure: how long students stay and when they leave.

## 8. Instructor payouts

The owner hires instructors to take some batches and pays them.

- `instructors`: name, phone, pay model (per class, per month, or a percentage of fees).
- Which batches each instructor takes.
- What the owner owes each instructor per month, what has been paid, and outstanding amounts.
- Profit per batch or location: fees collected minus instructor cost.

## 9. Convenience and polish

- **Start Menu entry**, plus an "Update Scrappy Records" shortcut.
- **App window** via `msedge --app=…`, with no address bar, so it feels like a normal app.
- **Start at login** and a **tray icon** (open / quit / back up now).
- In-app **backup now / restore** buttons. (Downloading everything as an Excel file, and
  uploading a roster or payments from a spreadsheet, are built: see the
  [feature guide](../feature-guide.md#downloading-and-uploading-excel).)
- **Undo / recently deleted** instead of hard delete.
- **Hindi (and other languages)** in the UI.
- **Phone access on the home Wi-Fi.** The server would bind to the LAN with a PIN, so the owner can
  check from their phone.
- **Business name setting:** the owner types in their school's name, and the app shows it in the
  header and window title. It is stored in the local database, so it never goes in the repo.
- A **signed `.exe` installer** (MSIX or Inno Setup) with auto-update, replacing the PowerShell
  one-liner.
- A dark mode, and a printable monthly summary.
- **One Excel writer.** The downloads (`services/exports.py`) and the monthly report's Excel
  file (`services/report_xlsx.py`) each set up their own headings, ₹ formats and column widths
  with openpyxl. They could share one small helper (and the report's Indian-grouping ₹ format).
  Not urgent: both are tested, and they look alike on purpose.

## 10. In-app feedback — done

**Done:** ⚙ Settings → **Send feedback** (see the
[feature guide](../feature-guide.md#settings-and-feedback)). The owner writes a message (Problem,
Idea or Question), with a picture of the screen unless she unticks it. The app saves it on the
laptop, then its server sends it to a small relay (a Cloudflare Worker in `relay/`), which files
it as an issue in a private feedback repo. The version, build, page, recent errors and the last
lines of the log go with it; the records never do.

How the old constraints were met:
- **Local only:** sending feedback is the app's one outbound call, started by the owner, and
  only feedback goes out ([ADR 0005](../adr/0005-feedback-is-the-only-outbound-call.md)).
- **No GitHub account / no token in the app:** the token lives only in the relay, as a secret,
  limited to the private feedback repo.
- **Privacy:** issues and screenshots land in the private repo, never the public one.
- **Offline:** feedback waits on the laptop and is retried at startup and every minute or so,
  backing off, until it goes.

Setup: [feedback relay runbook](../runbooks/feedback-relay-setup.md).

**Later:** a "Your feedback" list in Settings (what was sent, and replies), and more settings in
the same menu (the business name).
