/**
 * The PRD's ledger rules ("Ledger rules" and "Dashboard for a selected month M"), re-implemented
 * in TypeScript for the development mock API only. The real rules live in the backend
 * (`backend/app/services/ledger.py`); this copy exists so the UI can be built, tested and
 * screenshotted before the backend is ready. It never ships (see "Mock API" in docs/runbooks/development.md).
 *
 * Months are "YYYY-MM" strings, which sort correctly as plain strings.
 */
import type {
  BacklogItem,
  BalanceStatus,
  DashboardResponse,
  LedgerMonth,
  MonthStatus,
  OverpaidItem,
  PaymentMethod,
  SuggestedPayment,
  YetToPayItem,
} from '@/api/types'
import { addMonths, monthsBetween, MONTHS_AHEAD } from '@/lib/format'

export interface StudentRow {
  id: number
  name: string
  phone: string | null
  guardian_name: string | null
  batch_label: string | null
  joined_month: string
  left_month: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface FeeChangeRow {
  id: number
  student_id: number
  effective_month: string
  amount_paise: number
  /** 'fee': set by the owner; 'away': the months away after coming back (backend FeeKind). */
  kind: 'fee' | 'away'
}

export interface PaymentRow {
  id: number
  student_id: number
  amount_paise: number
  paid_on: string
  for_month: string
  method: PaymentMethod
  note: string | null
  created_at: string
  updated_at: string
}

/** Everything the ledger needs to know about one student. */
export interface StudentBook {
  student: StudentRow
  fees: FeeChangeRow[]
  payments: PaymentRow[]
}

/** A month after the student's last month (a payment for it can't be for that month). */
const afterLeaving = (student: StudentRow, month: string) =>
  student.left_month !== null && month > student.left_month

/** Rule 1: active from joined_month up to and including left_month. */
export function isActive(student: StudentRow, month: string): boolean {
  return (
    student.joined_month <= month && (student.left_month === null || month <= student.left_month)
  )
}

/** The fee in effect for a month: the latest fee change on or before it. */
export function feeFor(fees: FeeChangeRow[], month: string): number {
  let fee = 0
  let best = ''
  for (const change of fees) {
    if (change.effective_month <= month && change.effective_month >= best) {
      best = change.effective_month
      fee = change.amount_paise
    }
  }
  return fee
}

/** Rule 2. */
export function expectedFor(book: StudentBook, month: string): number {
  return isActive(book.student, month) ? feeFor(book.fees, month) : 0
}

/** Rule 3, for every month at once. */
export function paidByMonth(payments: PaymentRow[]): Map<string, number> {
  const paid = new Map<string, number>()
  for (const p of payments) paid.set(p.for_month, (paid.get(p.for_month) ?? 0) + p.amount_paise)
  return paid
}

/** Rule 4. */
export function monthStatus(expected: number, paid: number): MonthStatus {
  if (paid > expected) return 'overpaid'
  if (expected === 0) return 'not_applicable'
  if (paid === expected) return 'paid'
  return paid === 0 ? 'unpaid' : 'partial'
}

function monthRange(from: string, to: string): string[] {
  const months: string[] = []
  for (let m = from; m <= to; m = addMonths(m, 1)) months.push(m)
  return months
}

/** One row per month from joined_month to the current month (or the last paid month, if later). */
export function ledgerMonths(book: StudentBook, now: string): LedgerMonth[] {
  const paid = paidByMonth(book.payments)
  let last = now > book.student.joined_month ? now : book.student.joined_month
  for (const m of paid.keys()) if (m > last) last = m
  let first = book.student.joined_month
  for (const m of paid.keys()) if (m < first) first = m
  return monthRange(first, last).map((month) => {
    const expected = expectedFor(book, month)
    const p = paid.get(month) ?? 0
    return {
      month,
      expected_paise: expected,
      paid_paise: p,
      remaining_paise: Math.max(0, expected - p),
      excess_paise: Math.max(0, p - expected),
      status: monthStatus(expected, p),
      is_due: month <= now,
    }
  })
}

/** Rule 6: all payments minus everything expected up to the current month. */
export function balance(book: StudentBook, now: string): number {
  const totalPaid = book.payments.reduce((sum, p) => sum + p.amount_paise, 0)
  const { joined_month, left_month } = book.student
  const end = left_month !== null && left_month < now ? left_month : now
  let expected = 0
  if (joined_month <= end) {
    for (const m of monthRange(joined_month, end)) expected += feeFor(book.fees, m)
  }
  return totalPaid - expected
}

/** What's left on every due month that is Unpaid or Partial (backend `owed`). */
export function owedPaise(book: StudentBook, now: string): number {
  const paid = paidByMonth(book.payments)
  const { joined_month, left_month } = book.student
  const end = left_month !== null && left_month < now ? left_month : now
  let owed = 0
  if (joined_month <= end) {
    for (const m of monthRange(joined_month, end)) {
      owed += Math.max(0, expectedFor(book, m) - (paid.get(m) ?? 0))
    }
  }
  return owed
}

/** Money paid for months after the current one, up to each month's fee (backend `paid_ahead`). */
export function paidAheadPaise(book: StudentBook, now: string): number {
  let ahead = 0
  for (const [m, p] of paidByMonth(book.payments)) {
    if (m > now && !afterLeaving(book.student, m)) ahead += Math.min(p, expectedFor(book, m))
  }
  return ahead
}

/** Rule 6 (backend `standing_status`): owing wins; then credit; then up to date. */
export function standingStatus(owed: number, credit: number): BalanceStatus {
  if (owed > 0) return 'owes'
  if (credit > 0) return 'credit'
  return 'up_to_date'
}

export { MONTHS_AHEAD }

/**
 * Prefill for Log payment (PRD ledger rule 9), exactly as `suggest_payment` in
 * backend/app/services/ledger.py:
 * 1. `owed`: the oldest due month that is Unpaid or Partial, with what's left on it.
 * 2. `next_unpaid`: otherwise the first enrolled month after the current one with a fee that
 *    isn't fully paid (Unpaid or Partial). Months with a 0 fee are skipped.
 * 3. `all_paid`: nothing left up to the latest month a payment can be logged for.
 */
export function suggestPayment(book: StudentBook, now: string): SuggestedPayment {
  const paid = paidByMonth(book.payments)
  const { joined_month, left_month } = book.student
  const line = (month: string) => {
    const expected = expectedFor(book, month)
    const p = paid.get(month) ?? 0
    return { expected, remaining: Math.max(0, expected - p), status: monthStatus(expected, p) }
  }
  const lastDue = left_month !== null && left_month < now ? left_month : now
  if (joined_month <= lastDue) {
    for (const month of monthRange(joined_month, lastDue)) {
      const l = line(month)
      if (l.status === 'unpaid' || l.status === 'partial') {
        return { for_month: month, amount_paise: l.remaining, reason: 'owed' }
      }
    }
  }
  const next = addMonths(now, 1)
  const start = next > joined_month ? next : joined_month
  let end = addMonths(now, MONTHS_AHEAD)
  if (left_month !== null && left_month < end) end = left_month
  if (start <= end) {
    for (const month of monthRange(start, end)) {
      const l = line(month)
      // A fee is due and isn't fully paid; a 0-fee month never is.
      if (l.status === 'unpaid' || l.status === 'partial') {
        return { for_month: month, amount_paise: l.remaining, reason: 'next_unpaid' }
      }
    }
  }
  return { for_month: null, amount_paise: null, reason: 'all_paid' }
}

/**
 * Backend `tenure_months`. Still coming: whole months since joining (joined August, now
 * September -> 1). Left before now: months enrolled, both ends counted (March to June -> 4).
 */
export function tenureMonths(student: StudentRow, now: string): number {
  const { joined_month, left_month } = student
  if (left_month !== null && left_month < now) {
    return Math.max(0, monthsBetween(joined_month, left_month) + 1)
  }
  return Math.max(0, monthsBetween(joined_month, now))
}

/**
 * Backend `credit`: what was paid above the fee, in every month with a payment (all of it
 * where the fee is 0: before joining, after leaving, a month away), including later months.
 */
export function creditPaise(book: StudentBook, now: string): number {
  void now
  let credit = 0
  for (const [month, p] of paidByMonth(book.payments)) {
    credit += Math.max(0, p - expectedFor(book, month))
  }
  return credit
}

/** Active until the left month has passed (PRD ledger rule 8). */
export function isStillActive(student: StudentRow, now: string): boolean {
  return student.left_month === null || student.left_month >= now
}

const byName = (a: { student_name: string }, b: { student_name: string }) =>
  a.student_name.localeCompare(b.student_name, 'en', { sensitivity: 'base' })

/** The PRD's "Dashboard for a selected month M". */
export function dashboard(books: StudentBook[], month: string, now: string): DashboardResponse {
  const summary = {
    expected_paise: 0,
    collected_paise: 0,
    paid_ahead_paise: 0,
    still_due_paise: 0,
    not_fully_paid_count: 0,
    active_student_count: 0,
  }
  const yetToPay: YetToPayItem[] = []
  const backlog: BacklogItem[] = []
  const overpaid: OverpaidItem[] = []

  for (const book of books) {
    const { student } = book
    const paid = paidByMonth(book.payments)
    const paidInMonth = paid.get(month) ?? 0
    summary.collected_paise += paidInMonth

    if (isActive(student, month)) {
      const expected = expectedFor(book, month)
      if (expected > 0) summary.active_student_count += 1 // only those with a fee due
      if (month > now) summary.paid_ahead_paise += Math.min(paidInMonth, expected)
      summary.expected_paise += expected
      summary.still_due_paise += Math.max(0, expected - paidInMonth)
      const status = monthStatus(expected, paidInMonth)
      if (status === 'unpaid' || status === 'partial') {
        summary.not_fully_paid_count += 1
        yetToPay.push({
          student_id: student.id,
          student_name: student.name,
          batch_label: student.batch_label,
          phone: student.phone,
          credit_paise: creditPaise(book, now),
          expected_paise: expected,
          paid_paise: paidInMonth,
          remaining_paise: expected - paidInMonth,
          status,
        })
      }
    }

    // Backlog: due months before M that are Unpaid or Partial.
    const lastBacklogMonth = addMonths(month, -1) < now ? addMonths(month, -1) : now
    const owed: BacklogItem['months'] = []
    if (student.joined_month <= lastBacklogMonth) {
      for (const m of monthRange(student.joined_month, lastBacklogMonth)) {
        const expected = expectedFor(book, m)
        const p = paid.get(m) ?? 0
        const status = monthStatus(expected, p)
        if (status === 'unpaid' || status === 'partial') {
          owed.push({
            month: m,
            expected_paise: expected,
            paid_paise: p,
            remaining_paise: expected - p,
            status,
          })
        }
      }
    }
    if (owed.length > 0) {
      backlog.push({
        student_id: student.id,
        student_name: student.name,
        batch_label: student.batch_label,
        phone: student.phone,
        months: owed,
        total_owed_paise: owed.reduce((sum, m) => sum + m.remaining_paise, 0),
        credit_paise: creditPaise(book, now),
      })
    }

    // Overpaid: months up to M (and not after now) where paid > expected; from the current
    // month on, also every later month paid above its fee (backend `build_dashboard`).
    for (const [m, p] of paid) {
      const later = m > now && month >= now
      if ((m > month || m > now) && !later) continue
      const expected = expectedFor(book, m)
      if (p > expected) {
        overpaid.push({
          student_id: student.id,
          student_name: student.name,
          batch_label: student.batch_label,
          phone: student.phone,
          month: m,
          expected_paise: expected,
          paid_paise: p,
          excess_paise: p - expected,
        })
      }
    }
  }

  yetToPay.sort(byName)
  backlog.sort(byName)
  overpaid.sort((a, b) => byName(a, b) || a.month.localeCompare(b.month))
  return { month, current_month: now, summary, yet_to_pay: yetToPay, backlog, overpaid }
}
