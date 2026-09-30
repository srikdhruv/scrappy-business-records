/**
 * Unassigned payments (top of the Payments page): payments from an uploaded file whose student
 * couldn't be matched. They count towards no one until they're given to a student here
 * (Assign), which makes them one of that student's payments, or deleted.
 */
import { CircleHelpIcon, Trash2Icon, UserCheckIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import {
  useAssignUnassigned,
  useDeleteUnassigned,
  useStudents,
  useUnassignedPayments,
} from '@/api/queries'
import type { UnassignedPaymentRead } from '@/api/types'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Panel } from '@/components/panel'
import { StudentCombobox } from '@/components/student-combobox'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'
import { formatDate, formatMonth, formatMonthShort, formatRupees } from '@/lib/format'
import { METHOD_LABELS, plural } from '@/lib/labels'
import { UNASSIGNED_SECTION_ID } from '@/lib/upload'

/** The section, shown only when there are any. */
export function UnassignedPayments() {
  const { data: rows = [] } = useUnassignedPayments()
  const [toDelete, setToDelete] = useState<UnassignedPaymentRead | null>(null)
  const remove = useDeleteUnassigned()
  if (rows.length === 0) return null
  const total = rows.reduce((sum, r) => sum + r.amount_paise, 0)

  return (
    <Panel
      id={UNASSIGNED_SECTION_ID}
      className="mb-6 border-partial/30"
      title="Unassigned payments"
      count={rows.length}
      description={
        <>
          From an uploaded file, but it wasn’t clear which student paid. They aren’t counted for
          anyone (or in <em>Collected</em>) until you give each one to a student.{' '}
          {plural(rows.length, 'payment')}, {formatRupees(total)} in all.
        </>
      }
    >
      <ul className="divide-y divide-border/70 border-t border-border/70">
        {rows.map((row) => (
          <UnassignedRow key={row.id} row={row} onDelete={() => setToDelete(row)} />
        ))}
      </ul>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title="Delete this unassigned payment?"
        confirmLabel="Delete payment"
        description={
          toDelete && (
            <>
              <p>
                <strong className="text-foreground">
                  {formatRupees(toDelete.amount_paise)} from “{toDelete.student_text}” for{' '}
                  {formatMonth(toDelete.for_month)}
                </strong>
                , paid on {formatDate(toDelete.paid_on)}, will be deleted.
              </p>
              <p>This can’t be undone.</p>
            </>
          )
        }
        onConfirm={async () => {
          if (!toDelete) return
          await remove.mutateAsync(toDelete.id)
          toast.success('Unassigned payment deleted', {
            description: `${formatRupees(toDelete.amount_paise)} from “${toDelete.student_text}”`,
          })
        }}
      />
    </Panel>
  )
}

function UnassignedRow({ row, onDelete }: { row: UnassignedPaymentRead; onDelete: () => void }) {
  const [studentId, setStudentId] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const assign = useAssignUnassigned()
  const { data: students = [] } = useStudents('all')
  const what = `${formatRupees(row.amount_paise)} from “${row.student_text}”`

  const submit = async () => {
    if (studentId === null) return
    setProblem(null)
    try {
      const payment = await assign.mutateAsync({ id: row.id, studentId })
      toast.success('Payment assigned', {
        description: `${formatRupees(payment.amount_paise)} for ${formatMonth(payment.for_month)} is now ${payment.student_name}’s`,
      })
    } catch (error) {
      setProblem(errorMessage(error))
    }
  }

  const likely = row.suggested_student_ids
    .map((id) => students.find((s) => s.id === id)?.name)
    .filter(Boolean)

  return (
    <li className="grid gap-3 px-6 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] md:items-start">
      <div className="min-w-0 space-y-1">
        <p className="text-lg font-extrabold wrap-break-word">
          {row.student_text}
          {row.phone && (
            <span className="ml-2 text-base font-semibold text-muted-foreground">{row.phone}</span>
          )}
        </p>
        <p className="text-base">
          <strong className="tabular-nums">{formatRupees(row.amount_paise)}</strong> for{' '}
          <span title={formatMonth(row.for_month)}>{formatMonthShort(row.for_month)}</span>, paid on{' '}
          {formatDate(row.paid_on)} · {METHOD_LABELS[row.method]}
        </p>
        {row.note && <p className="text-sm wrap-break-word text-muted-foreground">{row.note}</p>}
        <p className="text-sm text-muted-foreground">
          {row.source ?? 'Upload'}
          {likely.length > 0 && <> · Maybe: {likely.join(', ')}</>}
        </p>
      </div>
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <StudentCombobox
              label={`Student who paid ${what}`}
              value={studentId}
              onChange={(id) => {
                setStudentId(id)
                setProblem(null)
              }}
              placeholder="Choose the student"
              suggestedIds={row.suggested_student_ids}
              invalid={problem !== null}
              className="h-11"
            />
          </div>
          <Button
            onClick={() => void submit()}
            disabled={studentId === null || assign.isPending}
            className="h-11"
            aria-label={`Assign ${what}`}
          >
            <UserCheckIcon aria-hidden />
            Assign
          </Button>
        </div>
        {problem && (
          <p role="alert" className="flex items-start gap-1.5 text-sm font-semibold text-owed">
            <CircleHelpIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            {problem}
          </p>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="text-owed hover:bg-owed-soft hover:text-owed"
          onClick={onDelete}
          aria-label={`Delete unassigned payment: ${what}`}
        >
          <Trash2Icon aria-hidden />
          Delete
        </Button>
      </div>
    </li>
  )
}
