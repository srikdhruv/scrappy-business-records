/** Mark a student as left (S3): they stop owing after the chosen month, and history is kept. */
import { useState } from 'react'
import { toast } from 'sonner'

import { useUpdateStudent } from '@/api/queries'
import type { StudentDetail } from '@/api/schema'
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
import { currentMonth, formatMonth } from '@/lib/format'
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
  const now = currentMonth()
  const [month, setMonth] = useState<string | null>(
    student.joined_month > now ? student.joined_month : now,
  )
  const update = useUpdateStudent()

  const save = async () => {
    if (!month) return
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
              {firstName(student.name)} will stop appearing in “Yet to pay” after this month. Their
              payments and history are kept, and you can find them under the Left tab.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="left-month">Last month they should pay for</Label>
            <MonthPicker
              id="left-month"
              value={month}
              onChange={setMonth}
              min={student.joined_month}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" size="lg" disabled={!month || update.isPending}>
              {update.isPending ? 'Saving…' : 'Mark as left'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
