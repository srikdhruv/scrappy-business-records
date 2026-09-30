/**
 * ‹ September 2026 › for the batches' numbers, like the dashboard's month switcher but smaller
 * (the page's title is the batch). Another month says so, with a way back to this one.
 */
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { addMonths, formatMonth } from '@/lib/format'

export function MonthNav({
  month,
  now,
  onChange,
}: {
  month: string
  now: string | undefined
  onChange: (month: string) => void
}) {
  const prev = addMonths(month, -1)
  const next = addMonths(month, 1)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className="-ml-2 flex items-center">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onChange(prev)}
          aria-label={`Previous month, ${formatMonth(prev)}`}
          className="rounded-full"
        >
          <ChevronLeftIcon className="size-5" />
        </Button>
        <p
          className="min-w-[9.5rem] text-center text-lg font-extrabold tabular-nums"
          aria-live="polite"
        >
          {formatMonth(month)}
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onChange(next)}
          aria-label={`Next month, ${formatMonth(next)}`}
          className="rounded-full"
        >
          <ChevronRightIcon className="size-5" />
        </Button>
      </div>
      {now && month !== now && (
        <span className="text-base text-muted-foreground">
          {month < now ? 'An earlier month.' : 'Not due yet.'}{' '}
          <button
            type="button"
            onClick={() => onChange(now)}
            className="rounded font-bold text-primary-strong underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Back to {formatMonth(now)}
          </button>
        </span>
      )}
    </div>
  )
}
