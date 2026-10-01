/**
 * How much of a month's fees is paid: a bar that fills up, with "₹X of ₹Y" and the percentage.
 * Green at 100%, amber below; muted when no fee is due that month.
 */
import type { BatchSummary } from '@/api/types'
import { formatRupees } from '@/lib/format'
import { cn } from '@/lib/utils'

export function PaidBar({
  summary,
  size = 'sm',
  className,
}: {
  summary: Pick<BatchSummary, 'expected_paise' | 'still_due_paise' | 'paid_percent'>
  size?: 'sm' | 'lg'
  className?: string
}) {
  const { expected_paise: expected, paid_percent: percent } = summary
  const paid = expected - summary.still_due_paise
  const done = percent === 100
  return (
    <div className={cn('grid gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <p className={cn('tabular-nums', size === 'lg' ? 'text-base' : 'text-sm')}>
          {percent === null ? (
            <span className="text-muted-foreground">No fees due this month</span>
          ) : (
            <>
              <span className="font-bold">{formatRupees(paid)}</span>
              <span className="text-muted-foreground"> of {formatRupees(expected)} paid</span>
            </>
          )}
        </p>
        {percent !== null && (
          <span
            className={cn(
              'shrink-0 font-extrabold tabular-nums',
              size === 'lg' ? 'text-xl' : 'text-base',
              done ? 'text-paid' : 'text-partial',
            )}
          >
            {percent}%
          </span>
        )}
      </div>
      {percent !== null && (
        <div
          className={cn('overflow-hidden rounded-full bg-muted', size === 'lg' ? 'h-3' : 'h-2')}
          aria-hidden
        >
          <div
            className={cn('h-full rounded-full', done ? 'bg-paid' : 'bg-primary')}
            style={{ width: `${Math.max(percent, percent > 0 ? 2 : 0)}%` }}
          />
        </div>
      )}
    </div>
  )
}
