/**
 * "Mark as coming again" for a student who has left (PRD ledger rule 11): asks which month they
 * are back from, so the months they were away are never owed, and shows the fee they'll owe from
 * then (which can be changed).
 */
import { useRef, useState } from 'react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { amountProblem } from '@/lib/amount'
import { errorMessage, fieldErrors } from '@/lib/errors'
import { newFeeSentence, returnFee } from '@/lib/fees'
import {
  addMonths,
  formatMonth,
  formatMonthSpan,
  formatRupees,
  MONTHS_AHEAD,
  paiseToRupeesInput,
  rupeesToPaise,
} from '@/lib/format'
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
  // The fee from the month they're back: worked out like the server does, until it's typed.
  const [typedFee, setTypedFee] = useState<string | null>(null)
  const [feeError, setFeeError] = useState<string | null>(null)
  const comeBack = useReturnStudent()
  // Blocks a second save while the first is still on its way (a double click or Enter).
  const saving = useRef(false)
  const name = firstName(student.name)

  // The months away: from the month after they left to the month before they're back.
  const lastAway = month ? addMonths(month, -1) : ''
  const away = lastAway >= firstAway ? formatMonthSpan(firstAway, lastAway) : null
  const usualFee = month ? returnFee(student.fee_history, student.left_month, month) : 0
  const feeText = typedFee ?? paiseToRupeesInput(usualFee)
  const fee = rupeesToPaise(feeText, { allowZero: true })
  const feeProblem = amountProblem(feeText, { allowZero: true, what: 'monthly fee' })
  // Money already logged for a month away counts as paid extra once that month has no fee.
  const paidWhileAway = away
    ? student.months.filter((m) => m.month >= firstAway && m.month <= lastAway && m.paid_paise > 0)
    : []

  const save = async () => {
    if (!month || saving.current) return
    setError(null)
    if (feeProblem || fee === null) {
      setFeeError(feeProblem)
      return
    }
    saving.current = true
    try {
      await comeBack.mutateAsync({ id: student.id, fromMonth: month, feePaise: fee })
      toast.success(`${student.name} is coming again`, {
        description: away
          ? `From ${formatMonth(month)}. Nothing is owed for ${away}.`
          : `From ${formatMonth(month)}.`,
      })
      onOpenChange(false)
    } catch (e) {
      const fields = fieldErrors(e)
      if (fields.from_month) setError(fields.from_month)
      else if (fields.monthly_fee_paise) setFeeError(fields.monthly_fee_paise)
      else toast.error(errorMessage(e))
    } finally {
      saving.current = false
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
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid content-start gap-2">
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
              />
              {error && (
                <p id="back-month-error" className="text-sm font-semibold text-owed">
                  {error}
                </p>
              )}
            </div>
            <div className="grid content-start gap-2">
              <Label htmlFor="back-fee">Monthly fee from then</Label>
              <div className="relative">
                <span
                  className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-base font-bold text-muted-foreground"
                  aria-hidden
                >
                  ₹
                </span>
                <Input
                  id="back-fee"
                  inputMode="decimal"
                  autoComplete="off"
                  value={feeText}
                  onChange={(e) => {
                    setTypedFee(e.target.value)
                    setFeeError(null)
                  }}
                  aria-invalid={Boolean(feeError) || undefined}
                  aria-describedby={feeError ? 'back-fee-error' : undefined}
                  className="pl-7 font-semibold tabular-nums"
                />
              </div>
              {feeError && (
                <p id="back-fee-error" className="text-sm font-semibold text-owed">
                  {feeError}
                </p>
              )}
            </div>
          </div>
          {month && (
            <div id="back-month-what" className="grid gap-1.5 rounded-xl bg-muted/60 px-4 py-3">
              {away && (
                <p>
                  <strong>{away}</strong>: no fee, so nothing is owed for the months away.
                </p>
              )}
              {!away && <p>Every month from {formatMonth(month)} counts, as if they never left.</p>}
              {fee !== null && <p>{newFeeSentence(student.fee_history, month, fee, now)}</p>}
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
