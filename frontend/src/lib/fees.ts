/**
 * Reading a student's fee schedule (`fee_history`: a fee from a month on, oldest first), the
 * same way the backend's ledger does (PRD ledger rules 2 and 7).
 */
import type { FeeChangeRead } from '@/api/types'
import { addMonths, formatMonth, formatMonthSpan, formatRupees } from '@/lib/format'

type Fees = readonly Pick<FeeChangeRead, 'effective_month' | 'amount_paise'>[]

/** The fee in effect for `month`: from the latest fee change on or before it (0 if none). */
export function feeAt(fees: Fees, month: string): number {
  let fee = 0
  let best = ''
  for (const f of fees) {
    if (f.effective_month <= month && f.effective_month >= best) {
      best = f.effective_month
      fee = f.amount_paise
    }
  }
  return fee
}

/** The first fee change after `month`, if any. */
export function nextFeeChange<F extends Fees[number]>(
  fees: readonly F[],
  month: string,
): F | undefined {
  return fees
    .filter((f) => f.effective_month > month)
    .toSorted((a, b) => a.effective_month.localeCompare(b.effective_month))[0]
}

/**
 * The fee someone coming back from `back` owes, as the backend's `return_fee` works it out:
 * the latest fee the owner set (not an 'away' row) on or before `back`. Usually the fee they
 * paid when they left.
 */
export function returnFee(fees: readonly FeeChangeRead[] | Fees, back: string): number {
  return feeAt(
    fees.filter((f) => !('kind' in f && f.kind === 'away')),
    back,
  )
}

/**
 * The fee history as it will be once they're back from `back` after leaving after `left`:
 * the gap's rows and every 'away' row after `left` are gone, a ₹0 'away' row starts the gap,
 * and `fee` starts at `back` (backend `return_student`).
 */
export function afterReturn(
  fees: readonly FeeChangeRead[],
  left: string,
  back: string,
  fee: number,
): FeeChangeRead[] {
  const firstAway = addMonths(left, 1)
  const kept = fees.filter(
    (f) =>
      !(f.effective_month > left && f.effective_month <= back) &&
      !(f.kind === 'away' && f.effective_month > left),
  )
  const added: FeeChangeRead[] = [{ id: -2, effective_month: back, amount_paise: fee, kind: 'fee' }]
  if (back > firstAway) {
    added.push({ id: -1, effective_month: firstAway, amount_paise: 0, kind: 'away' })
  }
  return [...kept, ...added].toSorted((a, b) => a.effective_month.localeCompare(b.effective_month))
}

/**
 * The months away that setting the left month to `left` would make owed again, as the backend's
 * `_drop_stale_away` works it out: a run of months away (an 'away' row up to the next fee the
 * owner set) that reaches `left` or comes after it is removed. The part up to `left` is then
 * owed. For example ["April–May 2026"].
 */
export function awayOwedAgain(fees: readonly FeeChangeRead[], left: string): string[] {
  const sorted = fees.toSorted((a, b) => a.effective_month.localeCompare(b.effective_month))
  const spans: string[] = []
  sorted.forEach((row, i) => {
    if (row.kind !== 'away') return
    const next = sorted.slice(i + 1).find((f) => f.kind === 'fee')
    const end = next ? addMonths(next.effective_month, -1) : undefined
    if (end !== undefined && end < left) return // an earlier absence: kept
    if (row.effective_month > left) return // after the left month: nothing is owed then anyway
    const last = end !== undefined && end < left ? end : left
    spans.push(formatMonthSpan(row.effective_month, last))
  })
  return spans
}

/** "₹1,500 a month", or "no fee" for ₹0. */
export function feeWords(paise: number): string {
  return paise === 0 ? 'no fee' : `${formatRupees(paise)} a month`
}

/**
 * What a new fee from `from` will do, in plain words, from the real schedule: it lasts until
 * the next fee change already set after it, if any. For example "From February 2026 they'll owe
 * ₹2,100 a month, until April 2026, when ₹1,800 (already scheduled) starts."
 */
export function newFeeSentence(fees: Fees, from: string, amount: number, now: string): string {
  const start =
    amount === 0
      ? `From ${formatMonth(from)} they’ll have no fee`
      : `From ${formatMonth(from)} they’ll owe ${formatRupees(amount)} a month`
  const next = nextFeeChange(fees, from)
  // A ₹0 fee with nothing after it never ends: say so, so a month off isn't left open by mistake.
  if (!next && amount === 0)
    return `They’ll have no fee from ${formatMonth(from)} onwards, with no end.`
  if (!next) return `${start}.`
  const already = next.effective_month > now ? 'already scheduled' : 'already set'
  const what = next.amount_paise === 0 ? 'no fee' : formatRupees(next.amount_paise)
  return `${start}, until ${formatMonth(next.effective_month)}, when ${what} (${already}) starts.`
}
