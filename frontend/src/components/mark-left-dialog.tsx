/** Mark a student as left (S3): they stop owing after the chosen month, and history is kept. */
import { useState } from 'react'
import { toast } from 'sonner'

import { useUpdateStudent } from '@/api/queries'
import type { StudentDetail } from '@/api/types'
import { AwayWarning } from '@/components/away-warning'
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
import { errorMessage } from '@/lib/errors'
import { awayOwedAgain } from '@/lib/fees'
import { addMonths, formatMonth, MONTHS_AHEAD } from '@/lib/format'
import { firstName } from '@/lib/labels'

export function MarkLeftDialog({
  student,
  open,
  onOpenChange,
}: {
  student: StudentDetail
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const now = student.current_month
  const [month, setMonth] = useState<string | null>(
    student.joined_month > now ? student.joined_month : now,
  )
  const update = useUpdateStudent()
  // Months away (from an earlier return) this left month would make owed again: ask first.
  const owedAgain = month ? awayOwedAgain(student.fee_history, month) : []
  const [confirmed, setConfirmed] = useState(false)

  const save = async () => {
    if (!month || (owedAgain.length > 0 && !confirmed)) return
    try {
      await update.mutateAsync({ id: student.id, body: { left_month: month } })
      toast.success(`${student.name} marked as left`, {
        description: `Last month they pay for: ${formatMonth(month)}`,
      })
      onOpenChange(false)
    } catch (error) {
      toast.error(errorMessage(error))
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
            <DialogTitle>Mark {student.name} as left?</DialogTitle>
            <DialogDescription>
              {firstName(student.name)} won’t owe anything after this month, and will then show as
              Left on the Students page. Their payments and history are kept.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="left-month">Last month they should pay for</Label>
            <MonthPicker
              id="left-month"
              label="Last month they should pay for"
              current={now}
              max={addMonths(now, MONTHS_AHEAD)}
              value={month}
              onChange={(m) => {
                setMonth(m)
                setConfirmed(false)
              }}
              min={student.joined_month}
            />
          </div>
          <AwayWarning spans={owedAgain} confirmed={confirmed} onConfirmedChange={setConfirmed} />
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              size="lg"
              disabled={!month || update.isPending || (owedAgain.length > 0 && !confirmed)}
            >
              {update.isPending ? 'Saving…' : 'Mark as left'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
