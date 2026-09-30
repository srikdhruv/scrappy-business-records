/**
 * Reading a student's fee schedule (`fee_history`: a fee from a month on, oldest first), the
 * same way the backend's ledger does (PRD ledger rules 2 and 7).
 */
import type { FeeChangeRead } from '@/api/types'
import { formatMonth, formatRupees } from '@/lib/format'

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
 * the latest fee change on or before `back`, skipping ₹0 ones after `left` (the months away of
 * an earlier return). Usually the fee they paid when they left.
 */
export function returnFee(fees: Fees, left: string, back: string): number {
  return feeAt(
    fees.filter((f) => !(f.effective_month > left && f.amount_paise === 0)),
    back,
  )
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
