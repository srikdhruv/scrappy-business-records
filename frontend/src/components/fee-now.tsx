/**
 * A student's monthly fee now, and the next change if one is already set: "No fee until
 * December 2026, then ₹1,000" (for someone coming back in December), or "₹1,800, then ₹2,000
 * from November 2026".
 */
import type { StudentRead } from '@/api/types'
import { formatMonth, formatMonthShort, formatRupees } from '@/lib/format'
import { cn } from '@/lib/utils'

type FeeStudent = Pick<StudentRead, 'monthly_fee_paise' | 'next_fee_change'>

const feeText = (paise: number) => (paise === 0 ? 'No fee' : formatRupees(paise))

/** `long` for the profile (one sentence); otherwise two short lines, for a table cell. */
export function FeeNow({ student, long = false }: { student: FeeStudent; long?: boolean }) {
  const now = student.monthly_fee_paise
  const next = student.next_fee_change
  const main = (
    <span className={cn('tabular-nums', long && 'font-bold', now === 0 && 'text-muted-foreground')}>
      {feeText(now)}
    </span>
  )
  if (!next) return main
  if (long) {
    const then = next.amount_paise === 0 ? 'no fee' : formatRupees(next.amount_paise)
    return (
      <span>
        {main}
        <span className="text-muted-foreground">
          {now === 0
            ? ` until ${formatMonth(next.effective_month)}, then ${then}`
            : `, then ${then} from ${formatMonth(next.effective_month)}`}
        </span>
      </span>
    )
  }
  return (
    <>
      {main}
      <span className="block text-sm font-normal text-muted-foreground">
        {feeText(next.amount_paise)} from {formatMonthShort(next.effective_month)}
      </span>
    </>
  )
}
