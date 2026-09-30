/**
 * The Dashboard answers "who is left to pay?" for one month (PRD D1–D5): a summary, the Yet to
 * pay list with a one-click Log payment, earlier months still owed, and overpayments.
 */
import {
  CalendarCheckIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  HandCoinsIcon,
  UserPlusIcon,
  UsersIcon,
  WalletIcon,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'

import { useDashboard, useStudents } from '@/api/queries'
import type { BacklogItem, DashboardResponse, OverpaidItem, YetToPayItem } from '@/api/types'
import { PageHeader } from '@/components/layout/page-header'
import { useLogPayment } from '@/components/log-payment'
import { Panel } from '@/components/panel'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/states'
import { CreditNote, StatusPill } from '@/components/status'
import { TONE_TEXT } from '@/lib/status'
import { StudentAvatar } from '@/components/student-avatar'
import { StudentFormDialog } from '@/components/student-form'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { addMonths, currentMonth, formatMonth, formatMonthShort, formatRupees } from '@/lib/format'
import { plural } from '@/lib/labels'
import { cn } from '@/lib/utils'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

export function DashboardPage() {
  const now = currentMonth()
  const [params, setParams] = useSearchParams()
  const requested = params.get('month')
  const month = requested && MONTH_RE.test(requested) ? requested : now
  const setMonth = (m: string) => setParams(m === now ? {} : { month: m }, { replace: true })

  const students = useStudents('all')
  const dashboard = useDashboard(month)
  const [newStudentOpen, setNewStudentOpen] = useState(false)

  const firstRun = students.data !== undefined && students.data.length === 0
  const monthName = formatMonth(month).split(' ')[0]

  return (
    <>
      <PageHeader
        eyebrow="Dashboard"
        title={<MonthSwitcher month={month} onChange={setMonth} />}
        description={
          month === now ? (
            'Who has paid this month, and who hasn’t yet.'
          ) : (
            <span className="inline-flex flex-wrap items-center gap-x-2">
              {month < now ? 'Looking back at an earlier month.' : 'Looking ahead.'}
              <button
                type="button"
                onClick={() => setMonth(now)}
                className="rounded font-bold text-primary-strong underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                Back to {formatMonth(now)}
              </button>
            </span>
          )
        }
      />

      {firstRun ? (
        <FirstRun onAdd={() => setNewStudentOpen(true)} />
      ) : dashboard.error && !dashboard.data ? (
        <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
      ) : !dashboard.data ? (
        <DashboardSkeleton />
      ) : (
        <div
          className={cn(
            'space-y-6 transition-opacity',
            dashboard.isPlaceholderData && 'opacity-60',
          )}
          aria-busy={dashboard.isPlaceholderData}
        >
          <SummaryCards data={dashboard.data} monthName={monthName ?? ''} />
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
            <YetToPay data={dashboard.data} />
            <div className="grid gap-6">
              <Backlog items={dashboard.data.backlog} month={month} />
              <Overpaid items={dashboard.data.overpaid} />
            </div>
          </div>
        </div>
      )}

      <StudentFormDialog open={newStudentOpen} onOpenChange={setNewStudentOpen} />
    </>
  )
}

function MonthSwitcher({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  const prev = addMonths(month, -1)
  const next = addMonths(month, 1)
  return (
    <div className="-ml-2 flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onChange(prev)}
        aria-label={`Previous month, ${formatMonth(prev)}`}
        className="rounded-full"
      >
        <ChevronLeftIcon className="size-6" />
      </Button>
      <h1
        className="min-w-[11ch] text-center text-3xl font-extrabold tracking-tight tabular-nums"
        aria-live="polite"
      >
        {formatMonth(month)}
      </h1>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => onChange(next)}
        aria-label={`Next month, ${formatMonth(next)}`}
        className="rounded-full"
      >
        <ChevronRightIcon className="size-6" />
      </Button>
    </div>
  )
}

// ---- Summary ------------------------------------------------------------------------------------

function SummaryCard({
  label,
  value,
  icon: Icon,
  iconClass,
  valueClass,
  children,
}: {
  label: string
  value: ReactNode
  icon: LucideIcon
  iconClass: string
  valueClass?: string
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border/80 bg-card p-5 shadow-soft">
      <div className="flex items-center justify-between gap-3">
        <p className="text-base font-bold text-muted-foreground">{label}</p>
        <span className={cn('flex size-9 items-center justify-center rounded-xl', iconClass)}>
          <Icon className="size-5" aria-hidden />
        </span>
      </div>
      <p className={cn('text-3xl font-extrabold tracking-tight tabular-nums', valueClass)}>
        {value}
      </p>
      {children && <div className="text-sm text-muted-foreground">{children}</div>}
    </div>
  )
}

function SummaryCards({ data, monthName }: { data: DashboardResponse; monthName: string }) {
  const s = data.summary
  const percent =
    s.expected_paise > 0
      ? Math.min(100, Math.round((s.collected_paise / s.expected_paise) * 100))
      : 0
  const allPaid = s.not_fully_paid_count === 0
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" role="group" aria-label="Summary">
      <SummaryCard
        label="Expected"
        value={formatRupees(s.expected_paise)}
        icon={CalendarCheckIcon}
        iconClass="bg-primary/25 text-primary-strong"
      >
        From {plural(s.active_student_count, 'student')} in {monthName}
      </SummaryCard>
      <SummaryCard
        label="Collected"
        value={formatRupees(s.collected_paise)}
        icon={WalletIcon}
        iconClass="bg-paid-soft text-paid"
      >
        <div
          className="mb-2 h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label="Collected so far"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className="h-full rounded-full bg-paid transition-all"
            style={{ width: `${percent}%` }}
          />
        </div>
        {percent}% of what’s expected
      </SummaryCard>
      <SummaryCard
        label="Still due"
        value={formatRupees(s.still_due_paise)}
        icon={HandCoinsIcon}
        iconClass={s.still_due_paise > 0 ? 'bg-owed-soft text-owed' : 'bg-paid-soft text-paid'}
        valueClass={s.still_due_paise > 0 ? 'text-owed' : 'text-paid'}
      >
        {s.still_due_paise > 0 ? `Left to collect for ${monthName}` : 'Nothing left to collect'}
      </SummaryCard>
      <SummaryCard
        label="Not fully paid"
        value={
          <>
            {s.not_fully_paid_count}
            <span className="ml-1.5 text-lg font-bold text-muted-foreground">
              of {s.active_student_count}
            </span>
          </>
        }
        icon={UsersIcon}
        iconClass={allPaid ? 'bg-paid-soft text-paid' : 'bg-partial-soft text-partial'}
        valueClass={allPaid ? 'text-paid' : undefined}
      >
        {allPaid
          ? 'Everyone has paid'
          : `${s.not_fully_paid_count === 1 ? 'Student' : 'Students'} to follow up with`}
      </SummaryCard>
    </div>
  )
}

// ---- Yet to pay ---------------------------------------------------------------------------------

function YetToPay({ data }: { data: DashboardResponse }) {
  const { openLogPayment } = useLogPayment()
  const items = data.yet_to_pay
  const monthName = formatMonth(data.month).split(' ')[0]

  return (
    <Panel
      title="Yet to pay"
      count={items.length}
      description={
        items.length > 0
          ? `${formatRupees(data.summary.still_due_paise)} still to come for ${formatMonth(data.month)}`
          : undefined
      }
    >
      {data.summary.active_student_count === 0 ? (
        <EmptyState title={`No students were coming in ${formatMonth(data.month)}.`} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={
            <span className="text-5xl" aria-hidden>
              🎉
            </span>
          }
          title={`Everyone’s paid for ${monthName}!`}
          className="py-14"
        >
          {formatRupees(data.summary.collected_paise)} collected from{' '}
          {plural(data.summary.active_student_count, 'student')}. Nothing to follow up on.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border/70">
          {items.map((item) => (
            <YetToPayRow
              key={item.student_id}
              item={item}
              onLog={() =>
                openLogPayment({
                  studentId: item.student_id,
                  forMonth: data.month,
                  amountPaise: item.remaining_paise,
                })
              }
            />
          ))}
        </ul>
      )}
    </Panel>
  )
}

function YetToPayRow({ item, onLog }: { item: YetToPayItem; onLog: () => void }) {
  const partial = item.status === 'partial'
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 px-6 py-4 transition-colors hover:bg-muted/30">
      <StudentAvatar name={item.student_name} />
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <Link
            to={`/students/${item.student_id}`}
            className="rounded text-base font-bold outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {item.student_name}
          </Link>
          <StatusPill tone={partial ? 'partial' : 'owed'} className="h-6 px-2.5 text-xs">
            {partial ? 'Partial' : 'Unpaid'}
          </StatusPill>
          {(item.credit_paise ?? 0) > 0 && <CreditNote paise={item.credit_paise!} />}
        </div>
        {item.batch_label && (
          <p className="truncate text-sm text-muted-foreground">{item.batch_label}</p>
        )}
      </div>
      <div className="w-40 text-right">
        <p className="text-lg leading-tight font-extrabold tabular-nums">
          {formatRupees(item.remaining_paise)}
          <span className="ml-1 text-sm font-semibold text-muted-foreground">left</span>
        </p>
        <p className="text-sm text-muted-foreground tabular-nums">
          {partial
            ? `${formatRupees(item.paid_paise)} of ${formatRupees(item.expected_paise)} paid`
            : `Fee ${formatRupees(item.expected_paise)}`}
        </p>
      </div>
      <Button
        variant="outline"
        onClick={onLog}
        className="border-primary/60 bg-primary/10 hover:bg-primary/25"
        aria-label={`Log payment for ${item.student_name}`}
      >
        Log payment
      </Button>
    </li>
  )
}

// ---- Backlog ------------------------------------------------------------------------------------

function Backlog({ items, month }: { items: BacklogItem[]; month: string }) {
  const total = items.reduce((sum, item) => sum + item.total_owed_paise, 0)
  return (
    <Panel
      title="Earlier months still owed"
      count={items.length}
      description={
        items.length > 0
          ? `${formatRupees(total)} in total from before ${formatMonth(month)}`
          : undefined
      }
    >
      {items.length === 0 ? (
        <QuietEmpty>Nothing owed from earlier months.</QuietEmpty>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border/70">
          {items.map((item) => (
            <li key={item.student_id}>
              <Link
                to={`/students/${item.student_id}`}
                className="block px-6 py-4 transition-colors outline-none hover:bg-muted/30 focus-visible:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
                aria-label={`${item.student_name} owes ${formatRupees(item.total_owed_paise)} from ${plural(item.months.length, 'earlier month')}. Open profile.`}
              >
                <div className="flex items-center gap-3">
                  <StudentAvatar name={item.student_name} size="sm" />
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                    <span className="truncate font-bold">{item.student_name}</span>
                    {(item.credit_paise ?? 0) > 0 && <CreditNote paise={item.credit_paise!} />}
                  </span>
                  <span className={cn('font-extrabold tabular-nums', TONE_TEXT.owed)}>
                    {formatRupees(item.total_owed_paise)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5 pl-11">
                  {item.months.map((m) => (
                    <span
                      key={m.month}
                      title={`${formatMonth(m.month)}: ${formatRupees(m.remaining_paise)} left`}
                      className={cn(
                        'inline-flex h-6 items-center rounded-full px-2.5 text-xs font-bold',
                        m.status === 'partial'
                          ? 'bg-partial-soft text-partial'
                          : 'bg-owed-soft text-owed',
                      )}
                    >
                      {formatMonthShort(m.month)}
                      {m.status === 'partial' && ' · part paid'}
                    </span>
                  ))}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

// ---- Overpaid -----------------------------------------------------------------------------------

function Overpaid({ items }: { items: OverpaidItem[] }) {
  return (
    <Panel title="Paid too much" count={items.length}>
      {items.length === 0 ? (
        <QuietEmpty>No one has paid more than their fee.</QuietEmpty>
      ) : (
        <ul className="divide-y divide-border/70 border-t border-border/70">
          {items.map((item) => (
            <li key={`${item.student_id}-${item.month}`}>
              <Link
                to={`/students/${item.student_id}`}
                className="flex items-center gap-3 px-6 py-3.5 transition-colors outline-none hover:bg-muted/30 focus-visible:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
              >
                <StudentAvatar name={item.student_name} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{item.student_name}</span>
                  <span className="block text-sm text-muted-foreground tabular-nums">
                    {formatMonth(item.month)} · paid {formatRupees(item.paid_paise)}, fee{' '}
                    {formatRupees(item.expected_paise)}
                  </span>
                </span>
                <span
                  className={cn('font-extrabold whitespace-nowrap tabular-nums', TONE_TEXT.credit)}
                >
                  +{formatRupees(item.excess_paise)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function QuietEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 border-t border-border/70 px-6 py-5 text-base text-muted-foreground">
      <CheckCircle2Icon className="size-5 text-paid" aria-hidden />
      {children}
    </p>
  )
}

// ---- First run and loading ----------------------------------------------------------------------

function FirstRun({ onAdd }: { onAdd: () => void }) {
  return (
    <Panel>
      <EmptyState
        className="py-16"
        icon={
          <span className="flex size-20 items-center justify-center rounded-full bg-primary/25 text-primary-strong">
            <UserPlusIcon className="size-10" aria-hidden />
          </span>
        }
        title="Welcome! Let’s add your first student."
        action={
          <Button size="lg" onClick={onAdd}>
            <UserPlusIcon aria-hidden />
            New student
          </Button>
        }
      >
        Add each student with their monthly fee. Then, whenever someone pays you, click{' '}
        <strong className="text-foreground">Log payment</strong>, and this page will show who is
        still left to pay.
      </EmptyState>
    </Panel>
  )
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading the dashboard">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-2xl border bg-card p-5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-8 w-32" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
        <div className="rounded-2xl border bg-card p-6">
          <Skeleton className="mb-6 h-6 w-32" />
          <ListSkeleton rows={6} />
        </div>
        <div className="rounded-2xl border bg-card p-6">
          <Skeleton className="mb-6 h-6 w-48" />
          <ListSkeleton rows={3} />
        </div>
      </div>
    </div>
  )
}
