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
  CreditMoveItem,
  DashboardResponse,
  LedgerMonth,
  MonthStatus,
  OverpaidItem,
  PaymentMethod,
  SuggestedPayment,
  YetToPayItem,
} from '@/api/types'
import { allocate, monthShare, type Allocation } from '@/lib/allocation'
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

/** Rule 10: where every payment's money goes (backend `allocate`), as of `now`. */
export function allocation(book: StudentBook, now: string): Allocation {
  return allocate(book.payments, book.student, (m) => expectedFor(book, m), now)
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

/** One month after extra money has been handed out (backend `month_line`). */
function monthLine(book: StudentBook, alloc: Allocation, month: string, now: string): LedgerMonth {
  const expected = expectedFor(book, month)
  const paid = book.payments
    .filter((p) => p.for_month === month)
    .reduce((sum, p) => sum + p.amount_paise, 0)
  const share = monthShare(alloc, month)
  const counted = share.paid_direct_paise + share.covered_by_credit_paise
  return {
    month,
    expected_paise: expected,
    paid_paise: paid,
    ...share,
    remaining_paise: Math.max(0, expected - counted),
    excess_paise: Math.max(0, paid - expected),
    status: monthStatus(expected, counted + share.extra_unused_paise),
    is_due: month <= now,
  }
}

/**
 * One row per month from joined_month (or the first paid month, if earlier) to the latest of
 * the current month, the last paid month and the last month extra money pays.
 */
export function ledgerMonths(book: StudentBook, now: string): LedgerMonth[] {
  const paid = paidByMonth(book.payments)
  const alloc = allocation(book, now)
  let last = now > book.student.joined_month ? now : book.student.joined_month
  for (const m of paid.keys()) if (m > last) last = m
  for (const mv of alloc.moves) if (mv.to_month > last) last = mv.to_month
  let first = book.student.joined_month
  for (const m of paid.keys()) if (m < first) first = m
  return monthRange(first, last).map((month) => monthLine(book, alloc, month, now))
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

/** What's left on every due month after extra money (backend `owed`). */
export function owedPaise(book: StudentBook, now: string): number {
  const alloc = allocation(book, now)
  const { joined_month, left_month } = book.student
  const end = left_month !== null && left_month < now ? left_month : now
  let owed = 0
  if (joined_month <= end) {
    for (const m of monthRange(joined_month, end)) {
      owed += Math.max(0, expectedFor(book, m) - (alloc.counted.get(m) ?? 0))
    }
  }
  return owed
}

/** What pays months after the current one, extra money included (backend `paid_ahead`). */
export function paidAheadPaise(book: StudentBook, now: string): number {
  let ahead = 0
  for (const [m, counted] of allocation(book, now).counted) if (m > now) ahead += counted
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
  const alloc = allocation(book, now)
  const { joined_month, left_month } = book.student
  const line = (month: string) => {
    const l = monthLine(book, alloc, month, now)
    return { remaining: l.remaining_paise, status: l.status }
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

/** Backend `credit`: money no month needed once extra money has paid what it can. */
export function creditPaise(book: StudentBook, now: string): number {
  return allocation(book, now).uses.reduce((sum, u) => sum + u.extra_unused_paise, 0)
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
  const creditMoves: CreditMoveItem[] = []

  for (const book of books) {
    const { student } = book
    const alloc = allocation(book, now)
    const line = monthLine(book, alloc, month, now)
    const counted = line.paid_direct_paise + line.covered_by_credit_paise
    summary.collected_paise += counted
    const who = {
      student_id: student.id,
      student_name: student.name,
      batch_label: student.batch_label,
      phone: student.phone,
    }

    if (isActive(student, month)) {
      if (line.expected_paise > 0) summary.active_student_count += 1 // only those with a fee due
      if (month > now) summary.paid_ahead_paise += counted
      summary.expected_paise += line.expected_paise
      summary.still_due_paise += line.remaining_paise
      if (line.status === 'unpaid' || line.status === 'partial') {
        summary.not_fully_paid_count += 1
        yetToPay.push({
          ...who,
          credit_paise: creditPaise(book, now),
          expected_paise: line.expected_paise,
          paid_paise: line.paid_paise,
          covered_by_credit_paise: line.covered_by_credit_paise,
          remaining_paise: line.remaining_paise,
          status: line.status,
        })
      }
    }

    // Backlog: due months before M that are Unpaid or Partial.
    const lastBacklogMonth = addMonths(month, -1) < now ? addMonths(month, -1) : now
    const owed: BacklogItem['months'] = []
    const end =
      student.left_month !== null && student.left_month < lastBacklogMonth
        ? student.left_month
        : lastBacklogMonth
    if (student.joined_month <= end) {
      for (const m of monthRange(student.joined_month, end)) {
        const l = monthLine(book, alloc, m, now)
        if (l.status === 'unpaid' || l.status === 'partial') {
          owed.push({
            month: m,
            expected_paise: l.expected_paise,
            paid_paise: l.paid_paise,
            covered_by_credit_paise: l.covered_by_credit_paise,
            remaining_paise: l.remaining_paise,
            status: l.status,
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

    // Overpaid (credit): months up to M (and not after now) holding money no month needed;
    // from the current month on, also later months (backend `build_dashboard`).
    for (const m of new Set(book.payments.map((p) => p.for_month))) {
      const later = m > now && month >= now
      if ((m > month || m > now) && !later) continue
      const l = monthLine(book, alloc, m, now)
      if (l.extra_unused_paise > 0) {
        overpaid.push({
          ...who,
          month: m,
          expected_paise: l.expected_paise,
          paid_paise: l.paid_paise,
          excess_paise: l.excess_paise,
          extra_unused_paise: l.extra_unused_paise,
        })
      }
    }

    // Extra money moved into or out of M.
    const mine = alloc.moves
      .filter((mv) => mv.to_month === month || mv.payment.for_month === month)
      .sort(
        (a, b) =>
          a.to_month.localeCompare(b.to_month) ||
          a.payment.paid_on.localeCompare(b.payment.paid_on) ||
          a.payment.id - b.payment.id,
      )
    for (const mv of mine) {
      creditMoves.push({
        ...who,
        payment_id: mv.payment.id,
        paid_on: mv.payment.paid_on,
        from_month: mv.payment.for_month,
        to_month: mv.to_month,
        amount_paise: mv.amount_paise,
      })
    }
  }

  yetToPay.sort(byName)
  backlog.sort(byName)
  overpaid.sort((a, b) => byName(a, b) || a.month.localeCompare(b.month))
  creditMoves.sort(byName) // stable: each student's moves keep their order
  return {
    month,
    current_month: now,
    summary,
    yet_to_pay: yetToPay,
    backlog,
    overpaid,
    credit_moves: creditMoves,
  }
}
