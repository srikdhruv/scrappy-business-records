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
import { useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'

import { ApiError } from '@/api/client'
import {
  useDeleteFeeChange,
  useDeleteStudent,
  usePayments,
  useStudent,
  useUpdateStudent,
} from '@/api/queries'
import type { FeeChangeRead, LedgerMonth, StudentDetail } from '@/api/types'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/layout/page-header'
import { useLogPayment } from '@/components/log-payment'
import { ComeBackDialog } from '@/components/come-back-dialog'
import { MarkLeftDialog } from '@/components/mark-left-dialog'
import { Panel } from '@/components/panel'
import { PaymentsTable } from '@/components/payments-table'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/states'
import { FeeNow } from '@/components/fee-now'
import { ExtraPaidNote, MonthStatusBadge, PaidAheadNote, StatusPill } from '@/components/status'
import { TONE_TEXT, balanceTone, standingLabel } from '@/lib/status'
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
import { feeAt, newFeeSentence } from '@/lib/fees'
import { addMonths, formatMonth, formatMonthShort, formatRupees } from '@/lib/format'
import { firstName, formatMonthCount, plural, tenurePhrase } from '@/lib/labels'
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
  const { openLogPayment, openEditPayment } = useLogPayment()
  const payments = usePayments({ student_id: student.id })
  const deleteStudent = useDeleteStudent()
  const updateStudent = useUpdateStudent()
  const [editOpen, setEditOpen] = useState(false)
  const [leftOpen, setLeftOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  // When a month was overpaid and has several payments, the Payments list shows just those.
  const [paymentsMonth, setPaymentsMonth] = useState<string | null>(null)
  const leaving = student.left_month !== null && student.is_active

  const [comeBackOpen, setComeBackOpen] = useState(false)
  // Marked as leaving, but that month hasn't passed: they're simply staying.
  const stay = async () => {
    try {
      await updateStudent.mutateAsync({ id: student.id, body: { left_month: null } })
      toast.success(`${student.name} is staying`)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }

  const logFor = (m: LedgerMonth) =>
    openLogPayment({ studentId: student.id, forMonth: m.month, amountPaise: m.remaining_paise })

  // An overpaid month is fixed by editing its payment (usually its month or amount).
  const fixMonth = (month: string) => {
    const forMonth = (payments.data ?? []).filter((p) => p.for_month === month)
    if (forMonth.length === 1) {
      openEditPayment(forMonth[0]!)
    } else {
      setPaymentsMonth(month)
      document.getElementById('student-payments')?.scrollIntoView({ behavior: 'smooth' })
    }
  }
  const shownPayments = useMemo(
    () => (payments.data ?? []).filter((p) => !paymentsMonth || p.for_month === paymentsMonth),
    [payments.data, paymentsMonth],
  )

  return (
    <>
      <BackLink />
      <PageHeader
        title={
          <div className="flex min-w-0 items-center gap-4">
            <StudentAvatar name={student.name} size="lg" />
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 className="min-w-0 text-3xl font-extrabold tracking-tight wrap-break-word">
                  {student.name}
                </h1>
                {student.left_month && (
                  <StatusPill tone="muted">
                    {leaving ? 'Leaving after' : 'Left after'} {formatMonth(student.left_month)}
                  </StatusPill>
                )}
              </div>
              {student.batch_label && (
                <p className="text-base wrap-break-word text-muted-foreground">
                  {student.batch_label}
                </p>
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
                onClick={() => (leaving ? void stay() : setComeBackOpen(true))}
                disabled={updateStudent.isPending}
              >
                <UndoIcon aria-hidden />
                {leaving ? 'Mark as staying' : 'Mark as coming again'}
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
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.7fr)]">
          <BalanceCard
            student={student}
            onLog={logFor}
            onFix={payments.data ? fixMonth : undefined}
          />
          <DetailsCard student={student} />
        </div>

        <Panel title="Month by month" description="What was due each month, and what came in.">
          <MonthHistory
            student={student}
            onLog={logFor}
            onFix={payments.data ? fixMonth : undefined}
          />
        </Panel>

        <Panel
          id="student-payments"
          title="Payments"
          count={student.payment_count}
          actions={
            paymentsMonth && (
              <Button variant="outline" onClick={() => setPaymentsMonth(null)}>
                Show all
              </Button>
            )
          }
          description={
            paymentsMonth ? `Showing payments for ${formatMonth(paymentsMonth)}.` : undefined
          }
        >
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
              payments={shownPayments}
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
      {comeBackOpen && student.left_month && (
        <ComeBackDialog
          student={{ ...student, left_month: student.left_month }}
          open={comeBackOpen}
          onOpenChange={setComeBackOpen}
        />
      )}
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
  onFix,
}: {
  student: StudentDetail
  onLog: (month: LedgerMonth) => void
  /** Undefined while the payments are still loading. */
  onFix?: (month: string) => void
}) {
  const afterLeft = (month: string) => student.left_month !== null && month > student.left_month
  // Money paid too much: any month paid above its fee (all of it where the fee is 0).
  const overpaid = student.months.filter((m) => m.status === 'overpaid')
  const credit = student.credit_paise
  const tone = balanceTone(student.status)
  // Paid ahead: the last month, after this one and still enrolled, paid in full without a gap.
  let aheadTo: string | undefined
  for (const m of student.months.filter((m) => !m.is_due && !afterLeft(m.month))) {
    if (m.expected_paise === 0) continue // a month off or away: nothing to pay ahead, go on
    if (m.status !== 'paid' && m.status !== 'overpaid') break
    aheadTo = m.month
  }
  const owed = student.months.filter(
    (m) => m.is_due && (m.status === 'unpaid' || m.status === 'partial'),
  )
  const oldest = owed[0]
  // Which months: "(Jul, Aug)", or a run like "(Jun–Sep)", else "(5 months)".
  const abbr = (month: string) => formatMonth(month).slice(0, 3)
  const inARow = owed.every((m, i) => i === 0 || m.month === addMonths(owed[i - 1]!.month, 1))
  const owedMonths =
    owed.length === 0
      ? ''
      : owed.length <= 3
        ? `(${owed.map((m) => abbr(m.month)).join(', ')})`
        : inARow && owed.length < 12
          ? `(${abbr(owed[0]!.month)}–${abbr(owed.at(-1)!.month)})`
          : `(${owed.length} months)`
  return (
    <section
      aria-label="Balance"
      className={cn(
        'flex min-w-0 flex-col justify-between gap-4 rounded-2xl border p-6 shadow-soft',
        tone === 'owed' && 'border-owed/25 bg-owed-soft/60',
        tone === 'credit' && 'border-credit/25 bg-credit-soft/60',
        tone === 'paid' && 'border-paid/25 bg-paid-soft/60',
      )}
    >
      <div>
        <p className="text-base font-bold text-muted-foreground">Balance</p>
        {/* Rule 6: anything owed for a due month is the headline, whatever else was paid. */}
        <p
          className={cn(
            'mt-1 text-4xl font-extrabold tracking-tight wrap-anywhere tabular-nums',
            TONE_TEXT[tone],
          )}
        >
          {standingLabel(student)}
          {owedMonths && (
            <span className="ml-2 text-xl font-bold whitespace-nowrap">{owedMonths}</span>
          )}
        </p>
        {(student.paid_ahead_paise > 0 || (credit > 0 && student.status === 'owes')) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {student.paid_ahead_paise > 0 && (
              <PaidAheadNote paise={student.paid_ahead_paise} to={aheadTo} className="text-sm" />
            )}
            {credit > 0 && student.status === 'owes' && (
              <ExtraPaidNote
                paise={credit}
                month={overpaid.length === 1 ? overpaid[0]!.month : undefined}
                className="text-sm"
              />
            )}
          </div>
        )}
        <p className="mt-2 text-base text-foreground/80">
          {student.status === 'owes'
            ? `${plural(owed.length, 'month')} not fully paid.`
            : student.status === 'credit'
              ? `Paid ${formatRupees(credit)} more than the fee.`
              : aheadTo
                ? `Everything due is paid, and ahead to ${formatMonth(aheadTo)}.`
                : 'Everything due so far has been paid.'}
        </p>
      </div>
      {oldest && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card/80 px-4 py-3">
          <div className="min-w-0">
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
      {credit > 0 && overpaid.length > 0 && (
        <div className="grid gap-2 rounded-xl bg-card/80 px-4 py-3">
          <p className="text-sm font-bold text-credit">{formatRupees(credit)} paid extra</p>
          <ul className="grid gap-1.5">
            {overpaid.map((m) => (
              <li key={m.month} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-base">
                  {afterLeft(m.month) ? (
                    // Nothing is owed after leaving: this was probably meant for another month.
                    <>
                      <span className="font-bold tabular-nums">
                        {formatRupees(m.paid_paise)} paid for {formatMonthShort(m.month)}
                      </span>
                      <span className="text-muted-foreground">
                        , after they left{oldest ? ` — was it for ${abbr(oldest.month)}?` : '.'}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="font-bold">{formatMonth(m.month)}</span>{' '}
                      <span className="text-muted-foreground tabular-nums">
                        · {formatRupees(m.paid_paise)} paid for a {formatRupees(m.expected_paise)}{' '}
                        fee
                      </span>
                    </>
                  )}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!onFix}
                  onClick={() => onFix?.(m.month)}
                >
                  <PencilIcon aria-hidden />
                  Edit payment
                </Button>
              </li>
            ))}
          </ul>
          <p className="text-sm text-muted-foreground">
            If it was meant for another month, change that payment’s month.
          </p>
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        {student.payment_count === 0
          ? 'No payments yet.'
          : `${formatRupees(student.total_paid_paise)} paid in total, across ${plural(student.payment_count, 'payment')}.`}
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
  return (
    <Panel title="Details">
      <dl className="grid gap-x-8 gap-y-4 px-6 pb-6 sm:grid-cols-2">
        <Detail label="Monthly fee">
          <FeeNow student={student} long />
        </Detail>
        <Detail label="Joined">
          {formatMonth(student.joined_month)}
          <span className="text-muted-foreground">
            {' '}
            ·{' '}
            {student.left_month && !student.is_active
              ? `left after ${formatMonth(student.left_month)} (${formatMonthCount(student.tenure_months)})`
              : tenurePhrase(student)}
          </span>
        </Detail>
        {student.fee_history.length > 1 && <FeeHistory student={student} />}
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

/**
 * Every fee and the month it starts (PRD ledger rule 7). A fee change that hasn't started yet
 * can be removed here; the fee before it then carries on.
 */
function FeeHistory({ student }: { student: StudentDetail }) {
  const fees = student.fee_history
  const now = student.current_month
  const [toRemove, setToRemove] = useState<FeeChangeRead | null>(null)
  const remove = useDeleteFeeChange()
  const rest = toRemove ? fees.filter((f) => f.id !== toRemove.id) : fees
  return (
    <div className="space-y-0.5 sm:col-span-2">
      <dt className="text-sm font-bold text-muted-foreground" id="fee-history">
        Fee history
      </dt>
      <dd>
        <ul aria-labelledby="fee-history" className="grid text-base">
          {fees.map((f, i) => {
            const scheduled = i > 0 && f.effective_month > now
            // Not the fee they came back on: it ends a run of months away, and removing it
            // would leave them away for good. Change it with Edit instead.
            const removable = scheduled && fees[i - 1]!.kind !== 'away'
            return (
              <li key={f.id} className="flex min-h-8 flex-wrap items-center gap-x-2">
                <span className="tabular-nums">
                  <span
                    className={cn('font-semibold', f.amount_paise === 0 && 'text-muted-foreground')}
                  >
                    {f.kind === 'away'
                      ? 'Away (no fee)'
                      : f.amount_paise === 0
                        ? 'No fee'
                        : formatRupees(f.amount_paise)}
                  </span>{' '}
                  <span className="text-muted-foreground">
                    from {formatMonthShort(f.effective_month)}
                  </span>
                </span>
                {scheduled && (
                  <>
                    <span className="text-sm text-muted-foreground">(not started yet)</span>
                  </>
                )}
                {removable && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-owed hover:bg-owed-soft hover:text-owed"
                      onClick={() => setToRemove(f)}
                      aria-label={`Remove the fee change from ${formatMonth(f.effective_month)}`}
                    >
                      Remove
                    </Button>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      </dd>
      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(open) => !open && setToRemove(null)}
        title={
          toRemove &&
          `Remove the ${toRemove.amount_paise === 0 ? 'no-fee change' : `${formatRupees(toRemove.amount_paise)} fee`} from ${formatMonth(toRemove.effective_month)}?`
        }
        confirmLabel="Remove fee change"
        pendingLabel="Removing…"
        description={
          toRemove && (
            <p>
              After this, {afterRemoving(rest, toRemove.effective_month, now)} Nothing else changes.
            </p>
          )
        }
        onConfirm={async () => {
          if (!toRemove) return
          await remove.mutateAsync({ studentId: student.id, feeChangeId: toRemove.id })
          toast.success('Fee change removed', {
            description: `${student.name}, ${formatMonth(toRemove.effective_month)}`,
          })
        }}
      />
    </div>
  )
}

/** "from November 2026 they'll owe ₹1,800 a month.": what's left once a fee change is gone. */
function afterRemoving(rest: FeeChangeRead[], month: string, now: string): string {
  const sentence = newFeeSentence(rest, month, feeAt(rest, month), now)
  return sentence.charAt(0).toLowerCase() + sentence.slice(1)
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

function MonthHistory({
  student,
  onLog,
  onFix,
}: {
  student: StudentDetail
  onLog: (month: LedgerMonth) => void
  /** Undefined while the payments are still loading. */
  onFix?: (month: string) => void
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
          const afterLeaving = student.left_month !== null && m.month > student.left_month
          const extra = m.status === 'overpaid'
          return (
            <TableRow key={m.month} className={cn(extra && 'bg-credit-soft/40')}>
              <TableCell className="pl-6 font-semibold">{formatMonth(m.month)}</TableCell>
              <TableCell className="text-right tabular-nums">
                {m.expected_paise > 0 ? formatRupees(m.expected_paise) : '—'}
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">
                {m.paid_paise > 0 ? formatRupees(m.paid_paise) : '—'}
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap items-center gap-2">
                  <MonthStatusBadge status={m.status} isDue={m.is_due || afterLeaving} />
                  {m.is_due && m.status === 'partial' && (
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {formatRupees(m.remaining_paise)} left
                    </span>
                  )}
                  {extra && (
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
                {extra && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!onFix}
                    onClick={() => onFix?.(m.month)}
                    aria-label={`Edit the payment for ${formatMonth(m.month)}`}
                  >
                    <PencilIcon aria-hidden />
                    Edit payment
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
