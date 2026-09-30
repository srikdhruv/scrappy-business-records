/**
 * Pick a month ("YYYY-MM") from a year of 12 buttons. Arrow keys move between months; Enter
 * picks. The trigger looks like an input and shows "October 2026".
 */
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { currentMonth, formatMonth } from '@/lib/format'
import { cn } from '@/lib/utils'

const pad = (n: number) => String(n).padStart(2, '0')
const toMonth = (year: number, month: number) => `${year}-${pad(month)}`

export function MonthPicker({
  id,
  value,
  onChange,
  placeholder = 'Pick a month',
  clearLabel,
  min,
  max,
  invalid,
  className,
  'aria-describedby': describedBy,
  'aria-label': ariaLabel,
}: {
  id?: string
  value: string | null
  onChange: (month: string | null) => void
  placeholder?: string
  /** If set, shows a button that clears the value (e.g. "Still coming"). */
  clearLabel?: string
  min?: string
  max?: string
  invalid?: boolean
  className?: string
  'aria-describedby'?: string
  'aria-label'?: string
}) {
  const [open, setOpen] = useState(false)
  const now = currentMonth()
  const initialYear = Number((value ?? now).slice(0, 4))
  const [year, setYear] = useState(initialYear)
  const gridRef = useRef<HTMLDivElement>(null)
  // After arrowing past December/January into the next/previous year, focus lands here.
  const pendingFocus = useRef<number | null>(null)

  useEffect(() => {
    if (pendingFocus.current === null) return
    gridRef.current?.querySelectorAll('button')[pendingFocus.current]?.focus()
    pendingFocus.current = null
  }, [year])

  const disabled = (month: string) => (min && month < min) || (max && month > max)

  const onOpenChange = (next: boolean) => {
    if (next) setYear(Number((value ?? now).slice(0, 4)))
    setOpen(next)
  }

  const pick = (month: string | null) => {
    onChange(month)
    setOpen(false)
  }

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -3,
      ArrowDown: 3,
    }
    const step = moves[event.key]
    if (step === undefined) return
    const buttons = [...(gridRef.current?.querySelectorAll('button') ?? [])]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (index < 0) return
    event.preventDefault()
    const next = index + step
    if (next < 0) {
      pendingFocus.current = next + 12
      setYear((y) => y - 1)
    } else if (next > 11) {
      pendingFocus.current = next - 12
      setYear((y) => y + 1)
    } else {
      buttons[next]?.focus()
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          aria-label={ariaLabel}
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
      <PopoverContent className="w-80 p-3" align="start">
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
                disabled={Boolean(disabled(month))}
                aria-pressed={selected}
                aria-label={formatMonth(month)}
                autoFocus={selected || (!value && isNow)}
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
