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
   - underpayments, where extra money went, and any extra kept as credit.
   - a **Monthly report** button: every student for that month in one table, to read, download
     as Excel or print (see "Monthly report for a selected month M").
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
| D3 | see partial payments, and where extra money went | I can sort them out, and trust a month paid "without a payment" |
| P5 | log a payment worth two months (or more) once | the extra pays the months still owed without me splitting it |
| D4 | look at a different month | I can check the past |
| D5 | log a payment straight from the dashboard | following up is one click |
| D6 | click out from the dashboard into a report of every student for the month: their status, whether they've paid, how much, how much extra, how much under | at month end I have one list of who paid what, and whom to chase, to keep (Excel) or print |

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
3. **Paid.** The sum of the student's payments whose `for_month = m`, exactly as typed
   (`paid_paise`). What **pays** a month is that, up to its fee, plus extra money from other
   payments (rule 10).
4. **Status for a month**, from what pays it (rule 10: its own payments up to the fee, plus
   extra money from other payments):
   - **Paid:** the fee is fully paid, and it is more than ₹0. It is **paid with credit** when
     some of it came from another payment's extra money (`covered_by_credit_paise > 0`); the
     status is still `paid`, and the screens name the payment it came from.
   - **Partial:** some, but not all, of the fee is paid.
   - **Unpaid:** a fee is due and nothing pays it.
   - **Overpaid:** some of the money logged for this month wasn't needed by any month, so it
     is kept as credit (`extra_unused_paise > 0`). Shown as **Paid extra**. Rare: extra money
     pays every month still owed first.
   - **Not applicable:** a ₹0 fee (or not enrolled), and none of its money is kept as credit.

   So a payment for a month the student isn't active in (before joining, after leaving, or a
   month away) is all extra: it pays the oldest month still owed (rule 10), and that month
   shows **Not applicable** with a note of where its money went.
5. **Months that count as due.** Only months up to and including the **current month** count as
   owed. What pays a later month they're enrolled in is "paid ahead": a payment logged for it,
   up to its fee, and extra money from other payments once every due month is paid (rule 10).
   Future months never appear in the dashboard's *Backlog*, and they are shown as **Paid
   ahead**.
6. **Standing.** What a student is shown as, overall (the students list and the profile):
   - **Owes ₹X** if any due month (an active month up to the current month) is still Unpaid or
     Partial after extra money has paid what it can (rule 10). ₹X is the sum of what's left on
     those months (`owed_paise`). A payment logged for a later month pays that month only (up
     to its fee), so paying ahead never hides a month still owed.
   - Otherwise **Credit ₹X** if there is credit (`credit_paise`, rule 10): money no month
     needed.
   - Otherwise **Up to date**.

   Money paid ahead (what pays later months they're still enrolled in) is shown next to the
   standing ("Paid ahead to Nov 2026"). The net figure
   `sum(all payments) − sum(expected for due months)` is still returned as `balance_paise`, for
   reference, but no headline uses it: a net 0 can hide months still owed (for example March
   and April unpaid while May and June are paid ahead).
7. **Changing a fee** always asks "from which month?" and records a fee change. Earlier months
   keep their old expected amount. The new fee lasts until the next fee change already set
   after it, if any (rule 2), and the form says so ("… until April 2026, when ₹1,800 (already
   scheduled) starts"). A fee change for a month that already has one replaces it. A fee change
   that **hasn't started yet** (its month is after the current month) can be removed, after a
   confirmation; the fee before it then carries on. That includes a planned month off and an
   *away* row for a return still to come, but never **the fee they came back on** (the one
   that ends a run of months away: without it they'd be away for good; change it with *Edit*).
   A fee change that has started (a month off already
   under way included), and the first fee (at `joined_month`), can never be removed, so past
   months never change by accident: to undo a month off that has started, set their usual fee
   from that month with *Edit*.
8. **Active or Left.** A student is **Active** until their left month has passed: they have no
   `left_month`, or `left_month ≥ current month`. After that they are **Left** (archived). So a
   student leaving after December shows as Active through December and as Left from January.
   The Students page's Active / Left filter uses this.
9. **Suggested payment** (what the *Log payment* form fills in), after extra money has paid
   what it can (rule 10):
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
10. **Extra money covers unpaid months (credit allocation).** The owner's decision: "If there's
    extra credit it should be applied to all of the missing months." A payment first pays the
    month it was logged for; the extra pays the oldest months still owed; anything still left
    counts as paid ahead, and then as credit. Worked out every time, from the payments as
    typed. **Nothing is stored or changed**: a payment always keeps the amount and month it was
    logged with.
    - **Order.** Payments are taken by the date they were paid, then in the order they were
      entered (`(paid_on, id)`).
    - **Pass 1.** Each payment pays its own month (`for_month`), up to what's still left of that
      month's fee. A month the student isn't enrolled in (before joining, after leaving), or
      with a ₹0 fee (a month off, a month away), takes nothing: all of that payment is extra.
    - **Pass 2.** Each payment's extra, in the same order, pays the **oldest month not fully
      paid**: first the due months (up to the current month; before *and* after the month it
      was logged for), then later months in order (**paid ahead**), up to the left month or two
      years ahead. Months with a ₹0 fee are skipped.
    - **Credit** is whatever is still left: money no month needed (`credit_paise`). It can only
      happen once every month they owe, up to their left month or two years ahead, is paid.
    - Because a payment first pays its own month, money logged for a later month never pays an
      older one; only its extra moves. Editing or deleting a payment changes where its extra
      goes straight away.

    The screens say where the money went: the month it paid says so ("Paid · ₹1,500 credit
    from the 5 Sep 2026 payment (for Sep 2026)"), the month it came from lists every month it
    paid ("₹1,500 extra → Aug 2026"), the payment says it ("₹1,500 went to Aug 2026"), the
    dashboard lists it (*Extra money used*), and *Log payment* previews it before saving
    ("₹1,500 more than the September fee: it will pay August 2026 (unpaid)", this payment's
    own money, as its row will say once saved). A payment that pays 4 or more months after the
    current one, or has money no month needs (kept as credit), is flagged gently on the profile
    and the dashboard, always with the reason ("Check: this ₹15,000 payment pays up to Jun 2027
    — 9 months ahead", "₹500 isn't needed by any month"), because a slip of the finger would
    otherwise just look paid ahead. Paying months still owed (a catch-up, a quarterly payment, a
    top-up) never is. The dashboard's Collected card and a month's Payments
    total say how they differ (money from, or to, other months).

    *Superseded:* until this change, payments were "kept exactly as typed": extra money was
    only shown as credit next to what was owed ("Paid ₹X extra in Jul 2026") for the owner to
    fix by editing the payment's month, and a month paid twice while the next was unpaid showed
    **Owes**. The stored data is the same; only how it's read changed, so a database from
    v0.1.0 needs no migration.
11. **Coming back after leaving.** When a student who left comes again, the owner says which
    month they're back from: any month after `left_month`, up to two years ahead (this month
    by default). In one step:
    - the months in between (from the month after `left_month` to the month before they're
      back) get a **₹0 fee**: one fee change at the month after `left_month`, marked as
      **away** (not a fee the owner set). They are *Not applicable* (rule 4), shown as
      **No fee** and, in *Fee history*, as **Away (no fee)**. They are never owed;
    - from the month they're back, they owe the fee shown in the same step, which the owner
      can change. It starts as the latest fee **the owner set** on or before that month:
      *away* rows never count, so an earlier return's months away can't become the fee they
      come back on. Usually that is the fee they paid when they left; a raise, or a month off,
      the owner set for a month while they were away counts. A gap always ends with a fee
      change at the month they're back. If they're back the very next month, there is no gap;
    - fee changes in the gap are replaced; so is every *away* fee change after `left_month`
      (leftovers of earlier returns). A ₹0 month off the owner set for after the return month
      is **kept**, and the step names it ("No fee in November 2026 was set earlier, and
      stays"), so she can remove it if it's wrong. Other later fee changes are kept too;
    - `left_month` is cleared, so they are Active again.

    **Changing the left month** removes the *away* runs that no longer fit: a run of months
    away (from an *away* fee change to the next fee the owner set) that reaches the new left
    month, or comes after it. For example: left after March, back in July (away from April),
    then the left month is corrected to May and they come back in July again: April and May
    are owed, June is away. An absence that ended before the new left month stays. Because
    that makes months owed again, *Mark as left* and *Edit* name them before saving ("April–May
    2026 will be owed again, because they were marked as away. Is that right?") and need a
    tick to go ahead. If it was a mistake: set the real left month (earlier is always allowed),
    then mark them as coming again from the month they came back; that puts the months away
    back.

    It happens once however fast it's clicked: the second click waits and then finds they are
    no longer marked as left. A payment already logged for a month in the gap is then all
    extra, like any payment for a month with no fee: it pays the oldest month still owed
    (rule 10). Once the left month has
    passed, *Edit* can only move it **earlier** (never empty it or move it later), because that
    would make every month away owed. If they came back after all, use this step from the
    month after they left (so nothing is skipped), then set a new left month if needed.

### Dashboard for a selected month M

| Section | Contents |
|---|---|
| **Summary** | Expected for M (all students active in M), and how many of them have a fee above ₹0 in M ("from N students"; a month off or a free place isn't counted) · Collected for M: what pays M (rule 10: payments logged for M, up to each fee, plus extra money from other payments that pays M); for a month after the current one this box is **Paid ahead** instead, the same amount (`paid_ahead_paise`) · Still due for M (what's left on M, over students active in M) · Number of students not fully paid, "of" that same N |
| **Yet to pay** | Students active in M whose status is Unpaid or Partial, with remaining amount and a *Log payment* button |
| **Backlog** | Students with any Unpaid or Partial month *before* M (and not after the current month, since only those are due), with the months listed and the total still owed. Includes students who have since left |
| **Credit moves** | Extra money that moved into or out of M (rule 10): from a payment logged for M to another month, or from another month's payment to M. Each with the payment's date, the month it was logged for, the month it paid and the amount. Shown only when there are some |
| **Overpaid** (credit) | Student-months up to M (and not after the current month) holding money no month needed, with that amount. For the current month or a later M, also later months, so every credit (rule 10) can be found here. Shown only when there are some |

Underpayments show as **Partial** in the *Yet to pay* and *Backlog* sections. For a future M,
*Yet to pay* lists who hasn't paid ahead yet.

On screen, *Backlog* is called **Earlier months still owed**, *Credit moves* is called **Extra
money used** and *Overpaid* is called **Extra kept as credit** (plain words). The
[feature guide](../feature-guide.md#dashboard) describes the screen in full.

### Monthly report for a selected month M

Opened from the Dashboard's **Monthly report** button (`/report?month=M`), with the same month
switcher. It goes by the month a payment is *for* (rule 3), not the day it was paid. One row per
student **relevant to M**: enrolled in M (a ₹0 fee included); or with money logged for M, or
extra money from another payment paying M; or still owing a due month before M (as in
*Backlog*, so students who have since left are included); or with money kept as credit in M or
earlier (as in *Overpaid*); or, for the current month and later ones, with any credit or money
paid ahead. So the current month's report has everyone the students list shows as owing, with
credit or paid ahead. Every value comes from the same ledger as the dashboard and the profiles
(rules 1–6 and 10), so they always agree.

The answers come first, then the details:

| Column | Contents |
|---|---|
| Student | As entered; stays in view when the table scrolls sideways |
| Status | **Unpaid**, **Partial**, **Not due yet** (a later month not fully paid ahead), **Paid (from extra)** (fully paid, partly by another payment's extra), **Paid**, **No fee** (a ₹0 fee; "Away" or "Not joined yet" under it when that's why), **Left** (M is after their left month; "after May 2026" under it) |
| Fee | Expected for M (rule 2) |
| Paid for this month | Paid for M, as typed (rule 3), with the dashboard's "Check: this payment…" note on a payment that may be a typo |
| Short | What's left on M |
| Total owed now | `owed_paise` (rule 6) |
| Paid from another payment's extra | Extra money from other payments that pays M, with each payment's date and the month it was logged for |
| Extra sent elsewhere | M's money above its fee that paid other months, with those months; money no month needed is "kept as credit" |
| Owed from earlier months | What's left on due months before M (the student's *Backlog* total), with the months as runs ("Jan–Jun 2026 (6 months)") |
| Kept as credit / paid ahead | `credit_paise` and `paid_ahead_paise` (rule 6) |
| Class/batch, Phone | As entered |

Rows start with whom to follow up (Unpaid, then Partial, Not due yet, Paid (from extra), Paid,
No fee, Left), then by name, the name compared as the screen's search compares it (accents,
apostrophes and hyphens ignored) so the Excel file breaks ties the same way. On screen the
owner can choose a status list (**Owes anything**: Total owed now above ₹0, the list to chase;
for a past month it is **Still owes for Aug 2026 or earlier**: owed today for that month or
earlier; **Short this month**; or one status), search by
name, and sort by any column. A **totals row** adds up the rows shown, and a **Collected** line
under it (paid for this month − extra sent elsewhere − extra kept as credit + paid from other
payments' extra); with nothing filtered they are the dashboard summary (Fee = Expected, Short =
Still due, "N of M not fully paid", Collected = Collected). **Download Excel** gives the rows on
screen (the same status list, search and sort, named in the title row) as
`scrappy-records-report-YYYY-MM.xlsx`: the same columns, ₹ amounts with Indian commas, frozen
headings, a bold totals row that adds up what Excel's own filter shows, and the Collected line.
**Print** prints what's on screen on A4 landscape, with the title "Scrappy Records — Fees
report, October 2026" and the date, and no menu or buttons.

*Later, with the Excel import:* its payments not yet matched to a student should appear as a
line on the report ("₹X of payments not yet matched to a student"), so the month's money is all
accounted for.

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
  - Updates never change or remove what the owner entered: the database layout only grows,
    and every release's saved data is tested to upgrade intact
    ([ADR 0004](../adr/0004-data-is-never-lost.md)).
- **Startup:** the app is usable within about 5 seconds of double-clicking the shortcut.
