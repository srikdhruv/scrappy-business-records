# Product requirements — MVP (v0.1)

## Problem

The target user runs a small class-based business, such as a dance, music or tuition school. They
teach, and sometimes hire instructors to teach, several batches across several locations.
Students pay a monthly fee, mostly over UPI. Today, "who has paid for which month" is tracked in
ad-hoc notes, such as messages sent to oneself on WhatsApp. That makes simple questions hard to
answer:

- Who hasn't paid this month?
- Who still owes for earlier months, and how much?
- Did someone pay too much or too little?

## Goal

A private app on the owner's own Windows laptop that answers those questions at a glance, and
where recording a payment takes seconds.

**Success looks like:** the owner stops keeping ad-hoc notes for fee tracking, and at any moment
can open the app and see who is left to pay.

## Users

- **Primary:** the business owner. They are non-technical, use a Windows laptop, and are
  comfortable with a browser and WhatsApp. They cannot be expected to use a terminal beyond
  pasting one line once.
- **Secondary:** a family member or helper who installs and updates it for them.

## Scope

### In the MVP

1. **Install and run locally.** One pasted line installs everything on a laptop with nothing
   pre-installed. A Desktop shortcut opens the app. Data persists and is backed up daily.
2. **Students.** Create, view, edit, archive (and bring back) and delete. Each student has a
   profile page.
3. **Payments.** Create, view, edit and delete. Each payment belongs to one student and one
   month.
4. **Dashboard.** For a chosen month (defaults to this month):
   - who is yet to pay, and how much is left;
   - backlog from earlier months;
   - overpayments and underpayments.
5. **Payments page.** Every payment, sortable and filterable.
6. **Students page.** Every student, with a status and how long they have been a student.

### Not in the MVP

See [future-features.md](future-features.md). In short: locations, batches, bank-statement
import, notifications, reminders, attendance, instructor payouts, analytics, and a Start Menu
entry.

## User stories

| # | As the owner, I want to… | So that… |
|---|---|---|
| S1 | add a student with their monthly fee and joining month | the app knows what they owe |
| S2 | edit a student, including changing their fee from a given month, and removing a fee change that hasn't started yet | past dues stay correct, and a raise set by mistake can be undone |
| S3 | mark a student as left (archive) | they stop owing fees but their history stays |
| S6 | mark a student who left as coming again, from a month I choose | the months they were away aren't owed |
| S4 | delete a student entered by mistake | the list stays clean |
| S5 | open a student's profile | I can see their details, month-by-month status and all payments |
| P1 | log a payment: student, amount, date paid, which month it is for, method | it is recorded |
| P2 | have the month and amount filled in sensibly | logging is fast |
| P3 | see all payments and sort by date, student, amount, month or method | I can find anything |
| P4 | edit or delete a payment | I can fix mistakes |
| D1 | see who hasn't fully paid for this month | I know whom to follow up with |
| D2 | see what is still owed from earlier months | nothing slips through |
| D3 | see overpayments and partial payments | I can sort them out |
| D4 | look at a different month | I can check the past |
| D5 | log a payment straight from the dashboard | following up is one click |

## Data captured

**Student**
- Name (required).
- Phone (optional).
- Parent/guardian name (optional).
- Class/batch label (optional free text, e.g. "Tue/Thu 5pm – Indiranagar").
- Monthly fee (required).
- Joined month (required; defaults to this month).
- Left month (optional).
- Notes.

**Payment**
- Student (required).
- Amount in ₹ (required, more than 0).
- Paid on (date; defaults to today).
- For month (required; defaults to the student's oldest unpaid month, otherwise the next month
  they haven't paid for; see ledger rule 9).
- Method: UPI / Cash / Other.
- Note.

## Ledger rules

These rules decide every number the app shows.

1. **Active months.** A student is active in month *m* if `joined_month ≤ m`, and either they
   have no `left_month` or `m ≤ left_month`. The left month is the *last month they owe*.
2. **Expected.** For an active month, the expected amount is the fee in effect for that month:
   the most recent fee change whose `effective_month ≤ m`. For an inactive month it is 0.
3. **Paid.** The sum of the student's payments whose `for_month = m`.
4. **Status for a month:**
   - **Paid:** paid = expected, and expected > 0.
   - **Partial:** 0 < paid < expected.
   - **Unpaid:** paid = 0 and expected > 0.
   - **Overpaid:** paid > expected.
   - **Not applicable:** expected = 0 and paid = 0.

   So a payment for a month the student isn't active in (before joining, after leaving) is
   **Overpaid** by its full amount.
5. **Months that count as due.** Only months up to and including the **current month** count as
   owed. A payment for a future month they're enrolled in is "paid ahead", **up to that
   month's fee**: future months never appear in the dashboard's *Backlog* or *Overpaid*, and
   they are shown as **Paid ahead**. Anything paid above a future month's fee (all of it, in a
   month with a ₹0 fee, such as a month away) is credit (rule 10), shown as **Paid extra**.
6. **Standing.** What a student is shown as, overall (the students list and the profile):
   - **Owes ₹X** if any due month (an active month up to the current month) is Unpaid or
     Partial. ₹X is the sum of what's left on those months (`owed_paise`). Money paid ahead or
     paid too much for another month never cancels this out, because payments are kept exactly
     as typed (rule 10).
   - Otherwise **Credit ₹X** if there is credit (`credit_paise`, rule 10): money paid above
     a month's fee, in any month, including months they weren't enrolled in (before joining,
     after leaving) and months with a ₹0 fee.
   - Otherwise **Up to date**.

   Money paid ahead (for later months they're still enrolled in, up to each month's fee) is
   shown next to the
   standing ("Paid ahead to Nov 2026"). The net
   figure `sum(all payments) − sum(expected for due months)` is still returned as
   `balance_paise`, for reference, but no headline uses it: a net 0 can hide months still owed
   (for example July paid twice instead of August).
7. **Changing a fee** always asks "from which month?" and records a fee change. Earlier months
   keep their old expected amount. The new fee lasts until the next fee change already set
   after it, if any (rule 2), and the form says so ("… until April 2026, when ₹1,800 (already
   scheduled) starts"). A fee change for a month that already has one replaces it. A fee change
   that **hasn't started yet** (its month is after the current month) can be removed, after a
   confirmation; the fee before it then carries on. A fee change that has started, and the
   first fee (at `joined_month`), can never be removed.
8. **Active or Left.** A student is **Active** until their left month has passed: they have no
   `left_month`, or `left_month ≥ current month`. After that they are **Left** (archived). So a
   student leaving after December shows as Active through December and as Left from January.
   The Students page's Active / Left filter uses this.
9. **Suggested payment** (what the *Log payment* form fills in):
   - the oldest month up to the current month that is Unpaid or Partial, with what's left on
     it;
   - otherwise, the first month *after* the current month that the student is enrolled in,
     that has a fee, and that isn't fully paid, with its fee (or what's left of it, if it is
     partly paid ahead). Usually that is next month. If they have paid ahead, it is the first
     month after what they have prepaid. Months with a ₹0 fee (a free place, or the months
     away before coming back, rule 11) are skipped: nothing is ever due for them;
   - if nothing is left to pay in the months they are enrolled in, up to the latest month a
     payment can be logged for (two years ahead), nothing is suggested. That happens when they
     have left and paid everything, have paid that far ahead, or have no fee to pay.

   It never suggests a month that is already fully paid, one with a ₹0 fee, one they aren't
   enrolled in, or one more than two years ahead.
10. **Credit.** The sum of `max(0, paid − expected)` over **every** month with a payment,
    including months the student wasn't enrolled in (before joining, after leaving) and months
    with a ₹0 fee, where the whole payment is extra, and months still to come. Anything paid
    for a month after they left or while they're away counts, even a month that hasn't come
    yet: they owe nothing then, so it was probably meant for another month ("₹1,500 paid for
    Oct 2026, after they left — was it for Jul?"). A later month they're enrolled in is "paid
    ahead" up to its fee (rule 5); only what's above the fee is credit. Payments stay
    exactly as they were typed: credit is never moved to other months or split automatically.
    Instead, wherever a student is shown as owing (*Yet to pay*, *Backlog*, the students list
    and the profile), their credit is shown next to it ("Paid ₹X extra in Jul 2026"), so the
    owner can fix the payment's month.
11. **Coming back after leaving.** When a student who left comes again, the owner says which
    month they're back from: any month after `left_month`, up to two years ahead (this month
    by default). In one step, with no new kind of record:
    - the months in between (from the month after `left_month` to the month before they're
      back) get a **₹0 fee**, one fee change at the month after `left_month`. They are
      *Not applicable* (rule 4), shown as **No fee**, and are never owed;
    - from the month they're back, they owe the fee shown in the same step, which the owner
      can change. It starts as the fee their schedule has for that month, **ignoring any ₹0
      fee after `left_month`** (the months away of an earlier return must never become the fee
      they come back on). Usually that is the fee they paid when they left; a raise set for a
      month while they were away counts. If they're back the very next month, there is no gap;
    - fee changes already set for a month in the gap are replaced by the ₹0 fee, and one at the
      month they're back gets the fee shown. Fee changes after that month are kept;
    - `left_month` is cleared, so they are Active again.

    It happens once however fast it's clicked: the second click waits and then finds they are
    no longer marked as left. A payment already logged for a month in the gap then counts as
    paid extra (rule 10), like any payment for a month with no fee. Once the left month has
    passed, *Edit* can only move it **earlier** (never empty it or move it later), because that
    would make every month away owed: coming back is always this step.

### Dashboard for a selected month M

| Section | Contents |
|---|---|
| **Summary** | Expected for M (all students active in M), and how many of them have a fee above ₹0 in M ("from N students"; a month off or a free place isn't counted) · Collected for M (payments whose `for_month = M`) · Still due for M (sum of `max(0, expected − paid)` over students active in M) · Number of students not fully paid, "of" that same N |
| **Yet to pay** | Students active in M whose status is Unpaid or Partial, with remaining amount and a *Log payment* button |
| **Backlog** | Students with any Unpaid or Partial month *before* M (and not after the current month, since only those are due), with the months listed and the total still owed. Includes students who have since left |
| **Overpaid** | Student-months up to M (and not after the current month) with paid > expected, with the excess amount |

Underpayments show as **Partial** in the *Yet to pay* and *Backlog* sections. For a future M,
*Yet to pay* lists who hasn't paid ahead yet.

On screen, *Backlog* is called **Earlier months still owed** and *Overpaid* is called **Paid too
much** (plain words). The [feature guide](../feature-guide.md#dashboard) describes the screen in
full.

## UX principles

- **Look and feel: warm.** A cream background with marigold as the main colour and terracotta
  as the accent, soft rounded cards, and a friendly but uncluttered layout. Status colours are
  green for paid, amber for partial and a muted red for owed. Text contrast must meet WCAG AA.
- **Name:** the app is called **Scrappy Records** everywhere (Desktop shortcut, window title,
  header).
- Large, readable type. Plain words: "Owes", "Paid", not "arrears".
- ₹ in Indian grouping (₹1,50,000). Dates like "5 Oct 2026". Months like "October 2026".
- Every destructive action asks for confirmation and says what will happen.
- The **+ Log payment** button is visible on every page.
- Works well at laptop widths (1280–1920px) and is still usable on a small window.

## Non-functional requirements

- **Install:** a stock Windows 10 (21H2+) or 11 laptop with no Python, Node, git or Docker. No
  admin rights needed.
- **Offline:** after install, no internet is needed.
- **Privacy:** data never leaves the laptop. The server listens on `127.0.0.1` only.
- **Durability:**
  - A daily backup is kept in *Documents*, for 30 days.
  - A backup is taken before every update and every schema migration.
- **Startup:** the app is usable within about 5 seconds of double-clicking the shortcut.
