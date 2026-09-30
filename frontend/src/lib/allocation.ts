/**
 * Extra money covers unpaid months (PRD ledger rule 10), in the browser.
 *
 * The same rule as `allocate` in backend/app/services/ledger.py, which is what every number
 * on screen comes from. This copy only previews what a payment being typed will do (the Log
 * payment form), and runs the development mock API. Keep the two in step.
 *
 * A payment first pays the month it was logged for, up to what's left of that month's fee.
 * What's left over pays the oldest months not fully paid: months up to the current month
 * first, then later ones (paid ahead), up to the left month or two years ahead. Months with no
 * fee are skipped. Anything still left is credit. Payments are handed out in (paid on, id)
 * order.
 */
import type { CreditSource, ExtraSent, FeeChangeRead } from '@/api/types'
import { feeAt } from '@/lib/fees'
import { addMonths, MONTHS_AHEAD } from '@/lib/format'

export interface AllocPayment {
  id: number
  for_month: string
  amount_paise: number
  paid_on: string
}

export interface Enrollment {
  joined_month: string
  left_month: string | null
}

/** Where one payment's money went: `direct + Σ extra_sent + extra_unused = amount`. */
export interface PaymentUse {
  payment: AllocPayment
  paid_direct_paise: number
  extra_sent: ExtraSent[]
  extra_unused_paise: number
}

export interface CreditMove {
  payment: AllocPayment
  to_month: string
  amount_paise: number
}

export interface Allocation {
  /** One per payment, in the order they were given. */
  uses: PaymentUse[]
  /** Every hand-out of extra money, in the order it happened. */
  moves: CreditMove[]
  /** What pays each month: its own payments (up to the fee) plus extra money. */
  counted: Map<string, number>
}

/** Rule 1 and 2: the fee for an enrolled month, 0 otherwise. */
export function expectedFrom(
  student: Enrollment,
  fees: readonly Pick<FeeChangeRead, 'effective_month' | 'amount_paise'>[],
) {
  return (month: string) =>
    student.joined_month <= month && (student.left_month === null || month <= student.left_month)
      ? feeAt(fees, month)
      : 0
}

function monthRange(from: string, to: string): string[] {
  const months: string[] = []
  for (let m = from; m <= to; m = addMonths(m, 1)) months.push(m)
  return months
}

/** The months extra money can pay, oldest first (backend `allocation_months`). */
export function allocationMonths(
  student: Enrollment,
  expected: (month: string) => number,
  now: string,
): string[] {
  let last = addMonths(now, MONTHS_AHEAD)
  if (student.left_month !== null && student.left_month < last) last = student.left_month
  if (student.joined_month > last) return []
  return monthRange(student.joined_month, last).filter((m) => expected(m) > 0)
}

const byDatePaid = (a: AllocPayment, b: AllocPayment) =>
  a.paid_on.localeCompare(b.paid_on) || a.id - b.id

/** Where every payment's money goes (backend `allocate`). */
export function allocate(
  payments: readonly AllocPayment[],
  student: Enrollment,
  expected: (month: string) => number,
  now: string,
): Allocation {
  const order = payments.map((_, i) => i).sort((a, b) => byDatePaid(payments[a]!, payments[b]!))
  const counted = new Map<string, number>()
  const direct = payments.map(() => 0)
  for (const i of order) {
    const p = payments[i]!
    const room = Math.max(0, expected(p.for_month) - (counted.get(p.for_month) ?? 0))
    direct[i] = Math.min(p.amount_paise, room)
    counted.set(p.for_month, (counted.get(p.for_month) ?? 0) + direct[i]!)
  }

  const targets = allocationMonths(student, expected, now)
  let t = 0
  const sent: ExtraSent[][] = payments.map(() => [])
  const unused = payments.map(() => 0)
  const moves: CreditMove[] = []
  for (const i of order) {
    const p = payments[i]!
    let left = p.amount_paise - direct[i]!
    while (left > 0 && t < targets.length) {
      const m = targets[t]!
      const room = expected(m) - (counted.get(m) ?? 0)
      if (room <= 0) {
        t += 1
        continue
      }
      const take = Math.min(room, left)
      counted.set(m, (counted.get(m) ?? 0) + take)
      left -= take
      sent[i]!.push({ to_month: m, amount_paise: take })
      moves.push({ payment: p, to_month: m, amount_paise: take })
    }
    unused[i] = left
  }
  return {
    uses: payments.map((payment, i) => ({
      payment,
      paid_direct_paise: direct[i]!,
      extra_sent: sent[i]!,
      extra_unused_paise: unused[i]!,
    })),
    moves,
    counted,
  }
}

/** One month's share of an allocation (the allocation fields of `LedgerMonth`). */
export function monthShare(alloc: Allocation, month: string) {
  const mine = alloc.uses.filter((u) => u.payment.for_month === month)
  const sources: CreditSource[] = alloc.moves
    .filter((mv) => mv.to_month === month)
    .map((mv) => ({
      payment_id: mv.payment.id,
      paid_on: mv.payment.paid_on,
      for_month: mv.payment.for_month,
      amount_paise: mv.amount_paise,
    }))
  const sent = new Map<string, number>()
  for (const u of mine) {
    for (const e of u.extra_sent) sent.set(e.to_month, (sent.get(e.to_month) ?? 0) + e.amount_paise)
  }
  return {
    paid_direct_paise: mine.reduce((sum, u) => sum + u.paid_direct_paise, 0),
    covered_by_credit_paise: sources.reduce((sum, s) => sum + s.amount_paise, 0),
    credit_sources: sources,
    extra_sent: [...sent]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([to_month, amount_paise]) => ({ to_month, amount_paise })),
    extra_unused_paise: mine.reduce((sum, u) => sum + u.extra_unused_paise, 0),
  }
}

/** What a new (or edited) payment would change, compared with the student's other payments. */
export interface PaymentPreview {
  /** What pays the month it's logged for. */
  own_paise: number
  /** Other months it would pay (oldest first), and how they stood before. */
  covers: {
    month: string
    amount_paise: number
    /** Before this payment: nothing paid (unpaid), some paid (part paid), or not due yet. */
    was: 'unpaid' | 'part_paid' | 'ahead'
    /** Whether it's then paid in full. */
    full: boolean
  }[]
  /** Left over as credit: no month needs it. */
  credit_paise: number
}

/**
 * The difference `draft` makes. Because the months covered depend only on how much was logged
 * for each month and in total (not on which payment it came from), this is exactly what saving
 * it would change, even when the extra that moves is another payment's.
 */
export function previewPayment(args: {
  others: readonly AllocPayment[]
  draft: AllocPayment
  student: Enrollment
  expected: (month: string) => number
  now: string
}): PaymentPreview {
  const { others, draft, student, expected, now } = args
  const before = allocate(others, student, expected, now)
  const after = allocate([...others, draft], student, expected, now)
  const covers: PaymentPreview['covers'] = []
  let own = 0
  for (const [month, total] of [...after.counted].sort(([a], [b]) => a.localeCompare(b))) {
    const was = before.counted.get(month) ?? 0
    const delta = total - was
    if (delta <= 0) continue
    if (month === draft.for_month) {
      own = delta
      continue
    }
    covers.push({
      month,
      amount_paise: delta,
      was: month > now ? 'ahead' : was === 0 ? 'unpaid' : 'part_paid',
      full: total >= expected(month),
    })
  }
  const unused = (a: Allocation) => a.uses.reduce((sum, u) => sum + u.extra_unused_paise, 0)
  return { own_paise: own, covers, credit_paise: unused(after) - unused(before) }
}
