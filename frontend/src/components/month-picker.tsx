/**
 * Pick a month ("YYYY-MM") from a year of 12 buttons. Arrow keys move between months; Enter
 * picks. The trigger looks like an input and shows "October 2026".
 */
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { addMonths, currentMonth, formatMonth } from '@/lib/format'
import { cn } from '@/lib/utils'

const pad = (n: number) => String(n).padStart(2, '0')
const toMonth = (year: number, month: number) => `${year}-${pad(month)}`

export function MonthPicker({
  id,
  label,
  current,
  value,
  onChange,
  placeholder = 'Pick a month',
  clearLabel,
  min,
  max,
  hint,
  invalid,
  className,
  'aria-describedby': describedBy,
}: {
  id?: string
  /** What the month is for ("For month"). Read out together with the chosen month. */
  label: string
  /** The server's current month, marked in the grid. Defaults to the laptop's. */
  current?: string
  value: string | null
  onChange: (month: string | null) => void
  placeholder?: string
  /** If set, shows a button that clears the value (e.g. "Still coming"). */
  clearLabel?: string
  min?: string
  max?: string
  /** A line under the grid, e.g. why some months are greyed out. */
  hint?: string
  invalid?: boolean
  className?: string
  'aria-describedby'?: string
}) {
  const [open, setOpen] = useState(false)
  const now = current ?? currentMonth()
  const autoId = useId()
  const buttonId = id ?? `${autoId}-button`
  const labelId = `${autoId}-label`
  const initialYear = Number((value ?? now).slice(0, 4))
  const [year, setYear] = useState(initialYear)
  const gridRef = useRef<HTMLDivElement>(null)
  // The month to focus once it's on screen (after opening, or after arrowing into another year).
  const pendingFocus = useRef<string | null>(null)

  useEffect(() => {
    const month = pendingFocus.current
    if (!month || !open) return
    const button = gridRef.current?.querySelector<HTMLButtonElement>(`[data-month="${month}"]`)
    if (button) {
      button.focus()
      pendingFocus.current = null
    }
  })

  const disabled = (month: string) => Boolean((min && month < min) || (max && month > max))

  /** Focus `month`, showing its year first if needed. */
  const focusMonth = (month: string) => {
    pendingFocus.current = month
    const monthYear = Number(month.slice(0, 4))
    if (monthYear !== year) setYear(monthYear)
    else gridRef.current?.querySelector<HTMLButtonElement>(`[data-month="${month}"]`)?.focus()
  }

  // On opening, focus the chosen month, else this month, else the nearest month allowed, so
  // the arrow keys work straight away.
  const startMonth = (): string => {
    for (const candidate of [value, now]) if (candidate && !disabled(candidate)) return candidate
    if (min && now < min) return min
    if (max && now > max) return max
    return now
  }

  const onOpenChange = (next: boolean) => {
    if (next) {
      const start = startMonth()
      pendingFocus.current = start
      setYear(Number(start.slice(0, 4)))
    }
    setOpen(next)
  }

  const pick = (month: string | null) => {
    onChange(month)
    setOpen(false)
  }

  // Arrows move by one month (left/right) or three (up/down), skipping greyed-out months and
  // moving into the next or previous year as needed.
  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -3,
      ArrowDown: 3,
    }
    const step = moves[event.key]
    const from = (document.activeElement as HTMLElement | null)?.dataset.month
    if (step === undefined || !from) return
    event.preventDefault()
    let next = addMonths(from, step)
    for (let i = 0; i < 48 && disabled(next); i++) next = addMonths(next, step)
    if (!disabled(next)) focusMonth(next)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/* Read as "For month: October 2026", the label and the current choice. */}
      <span id={labelId} className="sr-only">
        {label}: {value ? formatMonth(value) : placeholder}
      </span>
      <PopoverTrigger asChild>
        <Button
          id={buttonId}
          type="button"
          variant="outline"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          aria-labelledby={labelId}
          className={cn(
            'h-11 w-full justify-between bg-card px-3 font-normal hover:bg-card',
            !value && 'text-muted-foreground',
            className,
          )}
        >
          {value ? formatMonth(value) : placeholder}
          <CalendarIcon className="size-5 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-3"
        align="start"
        onOpenAutoFocus={(event) => {
          // Not the "Previous year" button: the month itself (see onOpenChange).
          event.preventDefault()
          const month = pendingFocus.current
          const button =
            month && gridRef.current?.querySelector<HTMLButtonElement>(`[data-month="${month}"]`)
          if (button) {
            button.focus()
            pendingFocus.current = null
          }
        }}
      >
        <div className="mb-2 flex items-center justify-between">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setYear((y) => y - 1)}
            aria-label="Previous year"
          >
            <ChevronLeftIcon />
          </Button>
          <span className="text-base font-bold" aria-live="polite">
            {year}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setYear((y) => y + 1)}
            aria-label="Next year"
          >
            <ChevronRightIcon />
          </Button>
        </div>
        <div
          ref={gridRef}
          className="grid grid-cols-3 gap-1.5"
          role="group"
          aria-label={`Months in ${year}`}
          onKeyDown={onGridKeyDown}
        >
          {Array.from({ length: 12 }, (_, i) => {
            const month = toMonth(year, i + 1)
            const selected = month === value
            const isNow = month === now
            return (
              <button
                key={i}
                type="button"
                data-month={month}
                disabled={disabled(month)}
                aria-pressed={selected}
                aria-label={formatMonth(month)}
                onClick={() => pick(month)}
                className={cn(
                  'h-11 rounded-lg text-base font-semibold transition-colors outline-none',
                  'focus-visible:ring-3 focus-visible:ring-ring/60',
                  'disabled:pointer-events-none disabled:opacity-35',
                  selected ? 'bg-primary text-primary-foreground' : 'hover:bg-muted',
                  isNow && !selected && 'ring-1 ring-primary ring-inset',
                )}
              >
                {formatMonth(month).slice(0, 3)}
              </button>
            )
          })}
        </div>
        {hint && <p className="mt-2 px-1 text-sm text-muted-foreground">{hint}</p>}
        {clearLabel && (
          <Button type="button" variant="ghost" className="mt-1 w-full" onClick={() => pick(null)}>
            <XIcon aria-hidden />
            {clearLabel}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
