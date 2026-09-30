/**
 * "Mark as coming again" for a student who has left (PRD ledger rule 11): asks which month they
 * are back from, so the months they were away are never owed.
 */
import { useState } from 'react'
import { toast } from 'sonner'

import { useReturnStudent } from '@/api/queries'
import type { StudentDetail } from '@/api/types'
import { MonthPicker } from '@/components/month-picker'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { errorMessage, fieldErrors } from '@/lib/errors'
import { feeAt, feeWords } from '@/lib/fees'
import { addMonths, formatMonth, formatMonthSpan, formatRupees, MONTHS_AHEAD } from '@/lib/format'
import { firstName } from '@/lib/labels'

export function ComeBackDialog({
  student,
  open,
  onOpenChange,
}: {
  student: StudentDetail & { left_month: string }
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const now = student.current_month
  const firstAway = addMonths(student.left_month, 1)
  const [month, setMonth] = useState<string | null>(now < firstAway ? firstAway : now)
  const [error, setError] = useState<string | null>(null)
  const comeBack = useReturnStudent()
  const name = firstName(student.name)

  // The months away: from the month after they left to the month before they're back.
  const lastAway = month ? addMonths(month, -1) : ''
  const away = lastAway >= firstAway ? formatMonthSpan(firstAway, lastAway) : null
  const fee = month ? feeAt(student.fee_history, month) : 0
  // Money already logged for a month away counts as paid extra once that month has no fee.
  const paidWhileAway = away
    ? student.months.filter((m) => m.month >= firstAway && m.month <= lastAway && m.paid_paise > 0)
    : []

  const save = async () => {
    if (!month) return
    setError(null)
    try {
      await comeBack.mutateAsync({ id: student.id, fromMonth: month })
      toast.success(`${student.name} is coming again`, {
        description: away
          ? `From ${formatMonth(month)}. Nothing is owed for ${away}.`
          : `From ${formatMonth(month)}.`,
      })
      onOpenChange(false)
    } catch (e) {
      const msg = fieldErrors(e).from_month
      if (msg) setError(msg)
      else toast.error(errorMessage(e))
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <DialogHeader>
            <DialogTitle>Mark {student.name} as coming again?</DialogTitle>
            <DialogDescription>
              {name} left after {formatMonth(student.left_month)}. Their payments and history are
              kept.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="back-month">Which month are they back from?</Label>
            <MonthPicker
              id="back-month"
              label="Which month are they back from?"
              current={now}
              min={firstAway}
              max={addMonths(now, MONTHS_AHEAD)}
              value={month}
              onChange={(m) => {
                setMonth(m)
                setError(null)
              }}
              invalid={Boolean(error)}
              aria-describedby={error ? 'back-month-error' : 'back-month-what'}
              className="sm:max-w-64"
            />
            {error && (
              <p id="back-month-error" className="text-sm font-semibold text-owed">
                {error}
              </p>
            )}
          </div>
          {month && (
            <div id="back-month-what" className="grid gap-1.5 rounded-xl bg-muted/60 px-4 py-3">
              {away && (
                <p>
                  <strong>{away}</strong>: no fee, so nothing is owed for the months away.
                </p>
              )}
              <p>
                {away ? `From ${formatMonth(month)}` : `Every month from ${formatMonth(month)}`}{' '}
                {fee === 0 ? 'they’ll have no fee' : `they’ll owe ${feeWords(fee)}`}
                {away ? ' again.' : ', as if they never left.'}
              </p>
              {paidWhileAway.length > 0 && (
                <p className="text-sm text-muted-foreground">
                  {paidWhileAway
                    .map((m) => `${formatRupees(m.paid_paise)} paid for ${formatMonth(m.month)}`)
                    .join(', ')}{' '}
                  will then show as paid extra. You can move it to another month afterwards.
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="lg" disabled={!month || comeBack.isPending}>
              {comeBack.isPending ? 'Saving…' : 'Mark as coming again'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
