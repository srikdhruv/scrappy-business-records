/**
 * The month in big letters with ‹ and › either side, as the title of the Dashboard and the
 * Report. `MonthNote` is the line under it: this month, or "Looking back / ahead" with a way
 * back to this month.
 */
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { addMonths, formatMonth } from '@/lib/format'

export function MonthSwitcher({
  month,
  onChange,
}: {
  month: string | undefined
  onChange: (m: string) => void
}) {
  if (!month) {
    return (
      <div className="flex h-10 items-center" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-9 w-64" />
      </div>
    )
  }
  const prev = addMonths(month, -1)
  const next = addMonths(month, 1)
  return (
    <div className="-ml-2 flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onChange(prev)}
        aria-label={`Previous month, ${formatMonth(prev)}`}
        className="rounded-full print:hidden"
      >
        <ChevronLeftIcon className="size-6" />
      </Button>
      <h1
        className="min-w-[11ch] text-center text-3xl font-extrabold tracking-tight tabular-nums"
        aria-live="polite"
      >
        {formatMonth(month)}
      </h1>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onChange(next)}
        aria-label={`Next month, ${formatMonth(next)}`}
        className="rounded-full print:hidden"
      >
        <ChevronRightIcon className="size-6" />
      </Button>
    </div>
  )
}

/**
 * Under the month: `current` for this month; for another month, "Looking back at an earlier
 * month." or "Looking ahead: October isn't due yet.", then "Back to September 2026".
 */
export function MonthNote({
  month,
  now,
  current,
  onBack,
}: {
  month: string | undefined
  now: string | undefined
  current: string
  onBack: () => void
}) {
  if (!month || !now) return ' '
  if (month === now) return current
  const name = formatMonth(month).split(' ')[0] ?? month
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      {month < now ? 'Looking back at an earlier month.' : `Looking ahead: ${name} isn’t due yet.`}
      <button
        type="button"
        onClick={onBack}
        className="rounded font-bold text-primary-strong underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 print:hidden"
      >
        Back to {formatMonth(now)}
      </button>
    </span>
  )
}
