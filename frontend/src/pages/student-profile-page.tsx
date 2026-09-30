/**
 * One student's profile (S5): details, balance, a month-by-month history and every payment.
 * Edit (S2), Mark as left (S3) and Delete (S4) live here.
 */
import {
  ArrowLeftIcon,
  DoorOpenIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
  UndoIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'

import { ApiError } from '@/api/client'
import { useDeleteStudent, usePayments, useStudent, useUpdateStudent } from '@/api/queries'
import type { LedgerMonth, StudentDetail } from '@/api/schema'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/layout/page-header'
import { useLogPayment } from '@/components/log-payment'
import { MarkLeftDialog } from '@/components/mark-left-dialog'
import { Panel } from '@/components/panel'
import { PaymentsTable } from '@/components/payments-table'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/states'
import { MonthStatusBadge, StatusPill } from '@/components/status'
import { TONE_TEXT, balanceTone } from '@/lib/status'
import { StudentAvatar } from '@/components/student-avatar'
import { StudentFormDialog } from '@/components/student-form'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { errorMessage } from '@/lib/errors'
import { formatMonth, formatMonthShort, formatRupees, formatTenure } from '@/lib/format'
import { firstName, plural } from '@/lib/labels'
import { cn } from '@/lib/utils'

function BackLink() {
  return (
    <Link
      to="/students"
      className="mb-4 inline-flex items-center gap-1.5 rounded text-base font-bold text-primary-strong outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ArrowLeftIcon className="size-4" aria-hidden />
      All students
    </Link>
  )
}

export function StudentProfilePage() {
  const { id } = useParams<{ id: string }>()
  const studentId = Number(id)
  const student = useStudent(Number.isInteger(studentId) && studentId > 0 ? studentId : undefined)

  if (
    !Number.isInteger(studentId) ||
    studentId <= 0 ||
    (student.error instanceof ApiError && student.error.status === 404)
  ) {
    return (
      <>
        <BackLink />
        <PageHeader title="Student not found" />
        <Panel>
          <EmptyState title="This student doesn’t exist any more.">
            They may have been deleted. Find everyone on the{' '}
            <Link to="/students" className="font-bold text-primary-strong hover:underline">
              Students
            </Link>{' '}
            page.
          </EmptyState>
        </Panel>
      </>
    )
  }

  if (student.error && !student.data) {
    return (
      <>
        <BackLink />
        <PageHeader title="Student" />
        <ErrorState error={student.error} onRetry={() => void student.refetch()} />
      </>
    )
  }

  if (!student.data) {
    return (
      <>
        <BackLink />
        <PageHeader
          title={
            <div className="flex items-center gap-4" aria-busy="true" aria-label="Loading">
              <Skeleton className="size-16 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-8 w-56" />
                <Skeleton className="h-4 w-40" />
              </div>
            </div>
          }
          logPayment={{ studentId }}
        />
        <ListSkeleton rows={6} />
      </>
    )
  }

  return <Profile student={student.data} />
}

function Profile({ student }: { student: StudentDetail }) {
  const navigate = useNavigate()
  const { openLogPayment } = useLogPayment()
  const payments = usePayments({ student_id: student.id })
  const deleteStudent = useDeleteStudent()
  const updateStudent = useUpdateStudent()
  const [editOpen, setEditOpen] = useState(false)
  const [leftOpen, setLeftOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)

  const comeBack = async () => {
    try {
      await updateStudent.mutateAsync({ id: student.id, body: { left_month: null } })
      toast.success(`${student.name} is active again`)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  return (
    <>
      <BackLink />
      <PageHeader
        title={
          <div className="flex items-center gap-4">
            <StudentAvatar name={student.name} size="lg" />
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 className="text-3xl font-extrabold tracking-tight">{student.name}</h1>
                {student.left_month && (
                  <StatusPill tone="muted">Left after {formatMonth(student.left_month)}</StatusPill>
                )}
              </div>
              {student.batch_label && (
                <p className="text-base text-muted-foreground">{student.batch_label}</p>
              )}
            </div>
          </div>
        }
        logPayment={{ studentId: student.id }}
        actions={
          <>
            <Button variant="outline" size="lg" onClick={() => setEditOpen(true)}>
              <PencilIcon aria-hidden />
              Edit
            </Button>
            {student.left_month ? (
              <Button
                variant="outline"
                size="lg"
                onClick={() => void comeBack()}
                disabled={updateStudent.isPending}
              >
                <UndoIcon aria-hidden />
                Mark as coming again
              </Button>
            ) : (
              <Button variant="outline" size="lg" onClick={() => setLeftOpen(true)}>
                <DoorOpenIcon aria-hidden />
                Mark as left
              </Button>
            )}
            <Button
              variant="ghost"
              size="lg"
              className="text-owed hover:bg-owed-soft hover:text-owed"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2Icon aria-hidden />
              Delete
            </Button>
          </>
        }
      />

      <div className="space-y-6">
        <div className="grid items-stretch gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)]">
          <BalanceCard
            student={student}
            onLog={(m) =>
              openLogPayment({
                studentId: student.id,
                forMonth: m.month,
                amountPaise: m.remaining_paise,
              })
            }
          />
          <DetailsCard student={student} />
        </div>

        <Panel title="Month by month" description="What was due each month, and what came in.">
          <MonthHistory
            student={student}
            onLog={(m) =>
              openLogPayment({
                studentId: student.id,
                forMonth: m.month,
                amountPaise: m.remaining_paise,
              })
            }
          />
        </Panel>

        <Panel title="Payments" count={student.payment_count}>
          {payments.error && !payments.data ? (
            <div className="p-6">
              <ErrorState error={payments.error} onRetry={() => void payments.refetch()} />
            </div>
          ) : !payments.data ? (
            <div className="p-6">
              <ListSkeleton rows={4} />
            </div>
          ) : (
            <PaymentsTable
              payments={payments.data}
              showStudent={false}
              empty={
                <EmptyState
                  title={`No payments from ${firstName(student.name)} yet.`}
                  action={
                    <Button onClick={() => openLogPayment({ studentId: student.id })}>
                      <PlusIcon aria-hidden />
                      Log payment
                    </Button>
                  }
                />
              }
            />
          )}
        </Panel>
      </div>

      <StudentFormDialog open={editOpen} onOpenChange={setEditOpen} student={student} />
      {leftOpen && <MarkLeftDialog student={student} open={leftOpen} onOpenChange={setLeftOpen} />}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete ${student.name}?`}
        confirmLabel="Delete student"
        description={
          <>
            <p>
              {student.payment_count === 0 ? (
                'They have no payments.'
              ) : (
                <>
                  This also deletes{' '}
                  <strong className="text-foreground">
                    {plural(student.payment_count, 'payment')} (
                    {formatRupees(student.total_paid_paise)})
                  </strong>
                  .
                </>
              )}{' '}
              This can’t be undone.
            </p>
            {!student.left_month && (
              <p>
                If {firstName(student.name)} has just stopped coming, use{' '}
                <strong className="text-foreground">Mark as left</strong> instead. That keeps their
                history.
              </p>
            )}
          </>
        }
        onConfirm={async () => {
          await deleteStudent.mutateAsync(student.id)
          toast.success(`${student.name} deleted`)
          void navigate('/students', { replace: true })
        }}
      />
    </>
  )
}

function BalanceCard({
  student,
  onLog,
}: {
  student: StudentDetail
  onLog: (month: LedgerMonth) => void
}) {
  const tone = balanceTone(student.status)
  const owed = student.months.filter(
    (m) => m.is_due && (m.status === 'unpaid' || m.status === 'partial'),
  )
  const oldest = owed[0]
  const amount = Math.abs(student.balance_paise)
  return (
    <section
      aria-label="Balance"
      className={cn(
        'flex flex-col justify-between gap-4 rounded-2xl border p-6 shadow-soft',
        tone === 'owed' && 'border-owed/25 bg-owed-soft/60',
        tone === 'credit' && 'border-credit/25 bg-credit-soft/60',
        tone === 'paid' && 'border-paid/25 bg-paid-soft/60',
      )}
    >
      <div>
        <p className="text-base font-bold text-muted-foreground">Balance</p>
        <p
          className={cn(
            'mt-1 text-4xl font-extrabold tracking-tight tabular-nums',
            TONE_TEXT[tone],
          )}
        >
          {student.status === 'up_to_date'
            ? 'Up to date'
            : `${student.status === 'owes' ? 'Owes' : 'Credit'} ${formatRupees(amount)}`}
        </p>
        <p className="mt-2 text-base text-foreground/80">
          {student.status === 'owes'
            ? `Not fully paid for ${plural(owed.length, 'month')}.`
            : student.status === 'credit'
              ? `Paid ${formatRupees(amount)} more than was due so far.`
              : 'Everything due so far has been paid.'}
        </p>
      </div>
      {oldest && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card/80 px-4 py-3">
          <div>
            <p className="text-sm font-bold text-muted-foreground">Oldest unpaid</p>
            <p className="text-base font-bold">
              {formatMonth(oldest.month)}{' '}
              <span className="font-semibold text-muted-foreground tabular-nums">
                · {formatRupees(oldest.remaining_paise)} left
              </span>
            </p>
          </div>
          <Button onClick={() => onLog(oldest)}>
            <PlusIcon aria-hidden />
            Log payment
          </Button>
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        {formatRupees(student.total_paid_paise)} paid in total, across{' '}
        {plural(student.payment_count, 'payment')}.
      </p>
    </section>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-sm font-bold text-muted-foreground">{label}</dt>
      <dd className="text-base">{children}</dd>
    </div>
  )
}

function DetailsCard({ student }: { student: StudentDetail }) {
  const fees = student.fee_history
  return (
    <Panel title="Details">
      <dl className="grid gap-x-8 gap-y-4 px-6 pb-6 sm:grid-cols-2">
        <Detail label="Monthly fee">
          <span className="font-bold tabular-nums">{formatRupees(student.monthly_fee_paise)}</span>
          {fees.length > 1 && (
            <span className="mt-1 block text-sm text-muted-foreground">
              {fees
                .map(
                  (f) =>
                    `${formatRupees(f.amount_paise)} from ${formatMonthShort(f.effective_month)}`,
                )
                .join(' · ')}
            </span>
          )}
        </Detail>
        <Detail label="Joined">
          {formatMonth(student.joined_month)}
          <span className="text-muted-foreground">
            {' '}
            ·{' '}
            {student.left_month
              ? `left after ${formatMonth(student.left_month)}`
              : `member for ${formatTenure(student.joined_month).toLowerCase()}`}
          </span>
        </Detail>
        <Detail label="Class or batch">{student.batch_label ?? <Muted>Not set</Muted>}</Detail>
        <Detail label="Phone">
          {student.phone ? (
            <span className="tabular-nums">{student.phone}</span>
          ) : (
            <Muted>Not set</Muted>
          )}
        </Detail>
        <Detail label="Parent or guardian">
          {student.guardian_name ?? <Muted>Not set</Muted>}
        </Detail>
        <Detail label="Notes">
          {student.notes ? (
            <span className="whitespace-pre-line">{student.notes}</span>
          ) : (
            <Muted>None</Muted>
          )}
        </Detail>
      </dl>
    </Panel>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

function MonthHistory({
  student,
  onLog,
}: {
  student: StudentDetail
  onLog: (month: LedgerMonth) => void
}) {
  // Newest first. Months after they left, with nothing paid, are just noise.
  const rows = student.months
    .filter((m) => !(student.left_month && m.month > student.left_month && m.paid_paise === 0))
    .toReversed()

  if (rows.length === 0) {
    return (
      <EmptyState title="Nothing due yet.">
        {firstName(student.name)} starts in {formatMonth(student.joined_month)}.
      </EmptyState>
    )
  }

  return (
    <Table className="min-w-[36rem]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="pl-6">Month</TableHead>
          <TableHead className="text-right">Fee</TableHead>
          <TableHead className="text-right">Paid</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="pr-6">
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((m) => {
          const owes = m.is_due && (m.status === 'unpaid' || m.status === 'partial')
          return (
            <TableRow key={m.month}>
              <TableCell className="pl-6 font-semibold">{formatMonth(m.month)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {m.expected_paise > 0 ? formatRupees(m.expected_paise) : '—'}
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">
                {m.paid_paise > 0 ? formatRupees(m.paid_paise) : '—'}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-2">
                  <MonthStatusBadge status={m.status} isDue={m.is_due} />
                  {m.is_due && m.status === 'partial' && (
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {formatRupees(m.remaining_paise)} left
                    </span>
                  )}
                  {m.is_due && m.status === 'overpaid' && (
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {formatRupees(m.excess_paise)} extra
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="pr-6 text-right">
                {owes && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onLog(m)}
                    aria-label={`Log payment for ${formatMonth(m.month)}`}
                  >
                    <PlusIcon aria-hidden />
                    Log payment
                  </Button>
                )}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
