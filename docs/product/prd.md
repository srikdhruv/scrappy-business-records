# Product requirements — MVP (v0.1)

## Problem

The primary user runs a dance school. She teaches (and hires instructors to teach) several
batches across several locations. Students pay a monthly fee, mostly over UPI. Today she tracks
"who has paid for which month" by sending WhatsApp messages to herself. It is hard to answer
simple questions:

- Who hasn't paid this month?
- Who still owes for earlier months, and how much?
- Did someone pay too much or too little?

## Goal

A private app on her own Windows laptop that answers those questions at a glance, and where
recording a payment takes seconds.

**Success looks like:** she stops using WhatsApp-to-self for fee tracking, and at any moment she
can open the app and see who is left to pay.

## Users

- **Primary:** the business owner. She is non-technical, uses a Windows laptop, and is
  comfortable with a browser and WhatsApp. She cannot be expected to use a terminal beyond
  pasting one line once.
- **Secondary:** a family member who installs and updates it for her.

## Scope

### In the MVP

1. **Install and run locally.** One pasted line installs everything on a laptop with nothing
   pre-installed. A Desktop shortcut opens the app. Data persists and is backed up daily.
2. **Students.** Create, view, edit, archive and delete. Each student has a profile page.
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
| S2 | edit a student, including changing their fee from a given month | past dues stay correct |
| S3 | mark a student as left (archive) | they stop owing fees but their history stays |
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
- For month (required; defaults to the student's oldest unpaid month, otherwise this month).
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
5. **Months that count as due.** Only months up to and including the **current month** count as
   owed. A payment for a future month is "paid ahead" and is not an overpayment.
6. **Balance.** A student's balance is `sum(all payments) − sum(expected for active months up to
   the current month)`.
   - Negative: **Owes ₹X**.
   - Positive: **Credit ₹X**.
   - Zero: **Up to date**.
7. **Changing a fee** always asks "from which month?" and records a fee change. Earlier months
   keep their old expected amount.

### Dashboard for a selected month M

| Section | Contents |
|---|---|
| **Summary** | Expected for M (all students active in M) · Collected for M (payments whose `for_month = M`) · Still due for M (sum of `max(0, expected − paid)`) · Number of students not fully paid |
| **Yet to pay** | Students active in M whose status is Unpaid or Partial, with remaining amount and a *Log payment* button |
| **Backlog** | Students with any Unpaid or Partial month *before* M, with the months listed and the total still owed |
| **Overpaid** | Student-months up to M with paid > expected, with the excess amount |

Underpayments show as **Partial** in the *Yet to pay* and *Backlog* sections.

## UX principles

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
