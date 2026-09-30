/**
 * The Dashboard answers "who is left to pay?" for one month (PRD D1–D5): a summary, the Yet to
 * pay list with a one-click Log payment, earlier months still owed, where extra money went
 * (PRD ledger rule 10), and any extra money kept as credit.
 *
 * "This month" is the server's (`current_month` in the response), never the browser's clock.
 * A month after it isn't due yet, so it is shown calmly: nothing is "owed" or red there.
 */
import {
  ArrowRightIcon,
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
import type {
  BacklogItem,
  CreditMoveItem,
  DashboardResponse,
  OverpaidItem,
  YetToPayItem,
} from '@/api/types'
import { PageHeader } from '@/components/layout/page-header'
import { useLogPayment } from '@/components/log-payment'
import { Panel } from '@/components/panel'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/states'
import { StatusPill } from '@/components/status'
import { StudentAvatar } from '@/components/student-avatar'
import { StudentFormDialog } from '@/components/student-form'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { addMonths, formatDate, formatMonth, formatMonthShort, formatRupees } from '@/lib/format'
import { checkText, groupMoves, monthRanges } from '@/lib/credit'
import { plural } from '@/lib/labels'
import { TONE_TEXT } from '@/lib/status'
import { cn } from '@/lib/utils'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/** Focus returns here after a payment is saved from a row (the row itself may be gone). */
const YET_TO_PAY_HEADING = 'yet-to-pay-heading'

const monthName = (month: string) => formatMonth(month).split(' ')[0] ?? month

export function DashboardPage() {
  const [params, setParams] = useSearchParams()
  const requested = params.get('month')
  // No month in the address: ask the server for its current month.
  const chosen = requested && MONTH_RE.test(requested) ? requested : undefined

  const students = useStudents('all')
  const dashboard = useDashboard(chosen)
  const [newStudentOpen, setNewStudentOpen] = useState(false)

  const data = dashboard.data
  const now = data?.current_month
  const month = chosen ?? data?.month
  const setMonth = (m: string) => setParams(m === now ? {} : { month: m }, { replace: true })

  const firstRun = students.data !== undefined && students.data.length === 0

  return (
    <>
      <PageHeader
        eyebrow="Dashboard"
        title={<MonthSwitcher month={month} onChange={setMonth} />}
        description={
          !month || !now ? (
            ' '
          ) : month === now ? (
            'Who has paid this month, and who hasn’t yet.'
          ) : (
            <span className="inline-flex flex-wrap items-center gap-x-2">
              {month < now
                ? 'Looking back at an earlier month.'
                : `Looking ahead: ${monthName(month)} isn’t due yet.`}
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
      ) : dashboard.error && !data ? (
        <ErrorState error={dashboard.error} onRetry={() => void dashboard.refetch()} />
      ) : !data ? (
        <DashboardSkeleton />
      ) : (
        <div
          className={cn(
            'min-w-0 space-y-6 transition-opacity',
            dashboard.isPlaceholderData && 'opacity-60',
          )}
          aria-busy={dashboard.isPlaceholderData}
        >
          <SummaryCards data={data} />
          <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
            <YetToPay data={data} />
            <div className="grid min-w-0 grid-cols-1 gap-6">
              <Backlog items={data.backlog} month={data.month} />
              {data.credit_moves.length > 0 && <CreditMoves items={data.credit_moves} />}
              {data.overpaid.length > 0 && <Credit items={data.overpaid} />}
            </div>
          </div>
        </div>
      )}

      <StudentFormDialog open={newStudentOpen} onOpenChange={setNewStudentOpen} />
    </>
  )
}

function MonthSwitcher({
  month,
  onChange,
}: {
  month: string | undefined
  onChange: (m: string) => void
}) {
  if (!month) {
    return (
      <div className="flex h-10 items-center" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-9 w-64" />
      </div>
    )
  }
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
    <div className="flex min-w-0 flex-col gap-3 rounded-2xl border border-border/80 bg-card p-5 shadow-soft">
      <div className="flex items-center justify-between gap-3">
        <p className="text-base font-bold text-muted-foreground">{label}</p>
        <span
          className={cn('flex size-9 shrink-0 items-center justify-center rounded-xl', iconClass)}
        >
          <Icon className="size-5" aria-hidden />
        </span>
      </div>
      <p
        className={cn(
          'text-3xl font-extrabold tracking-tight wrap-anywhere tabular-nums',
          valueClass,
        )}
      >
        {value}
      </p>
      {children && <div className="text-sm text-muted-foreground">{children}</div>}
    </div>
  )
}

function SummaryCards({ data }: { data: DashboardResponse }) {
  const s = data.summary
  const name = monthName(data.month)
  const ahead = data.month > data.current_month
  // For a later month, only what's paid up to each fee is "paid ahead" (the rest is extra).
  const inHand = ahead ? s.paid_ahead_paise : s.collected_paise
  const percent =
    s.expected_paise > 0 ? Math.min(100, Math.round((inHand / s.expected_paise) * 100)) : 0
  const allPaid = s.not_fully_paid_count === 0
  const nobody = s.active_student_count === 0
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" role="group" aria-label="Summary">
      <SummaryCard
        label="Expected"
        value={formatRupees(s.expected_paise)}
        icon={CalendarCheckIcon}
        iconClass="bg-primary/25 text-primary-strong"
      >
        From {plural(s.active_student_count, 'student')} in {name}
      </SummaryCard>
      <SummaryCard
        label={ahead ? 'Paid ahead' : 'Collected'}
        value={formatRupees(inHand)}
        icon={WalletIcon}
        iconClass={ahead ? 'bg-credit-soft text-credit' : 'bg-paid-soft text-paid'}
      >
        <div
          className="mb-2 h-2 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={ahead ? 'Paid ahead so far' : 'Collected so far'}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className={cn('h-full rounded-full transition-all', ahead ? 'bg-credit' : 'bg-paid')}
            style={{ width: `${percent}%` }}
          />
        </div>
        {percent}% of what’s expected
        <CollectedNote summary={s} name={name} />
      </SummaryCard>
      {ahead ? (
        <SummaryCard
          label="Not due yet"
          value={formatRupees(s.still_due_paise)}
          icon={HandCoinsIcon}
          iconClass="bg-muted text-muted-foreground"
        >
          Due in {name}
        </SummaryCard>
      ) : (
        <SummaryCard
          label="Still due"
          value={formatRupees(s.still_due_paise)}
          icon={HandCoinsIcon}
          iconClass={
            nobody
              ? 'bg-muted text-muted-foreground'
              : s.still_due_paise > 0
                ? 'bg-owed-soft text-owed'
                : 'bg-paid-soft text-paid'
          }
          valueClass={
            nobody ? 'text-muted-foreground' : s.still_due_paise > 0 ? 'text-owed' : 'text-paid'
          }
        >
          {nobody
            ? 'Nothing due'
            : s.still_due_paise > 0
              ? `Left to collect for ${name}`
              : 'Nothing left to collect'}
        </SummaryCard>
      )}
      <SummaryCard
        label={ahead ? 'Not paid ahead' : 'Not fully paid'}
        value={
          nobody ? (
            '—'
          ) : (
            <>
              {s.not_fully_paid_count}
              <span className="ml-1.5 text-lg font-bold text-muted-foreground">
                of {s.active_student_count}
              </span>
            </>
          )
        }
        icon={UsersIcon}
        iconClass={
          ahead || nobody
            ? 'bg-muted text-muted-foreground'
            : allPaid
              ? 'bg-paid-soft text-paid'
              : 'bg-partial-soft text-partial'
        }
        valueClass={nobody ? 'text-muted-foreground' : allPaid && !ahead ? 'text-paid' : undefined}
      >
        {nobody
          ? `No students in ${name}`
          : ahead
            ? 'Nothing to follow up yet'
            : allPaid
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
  const name = monthName(data.month)
  const ahead = data.month > data.current_month

  return (
    <Panel
      className="min-w-0"
      headingId={YET_TO_PAY_HEADING}
      title={ahead ? 'Not paid ahead yet' : 'Yet to pay'}
      count={items.length}
      description={
        items.length === 0
          ? undefined
          : ahead
            ? `${name} isn’t due yet. These students haven’t paid for it ahead of time.`
            : `${formatRupees(data.summary.still_due_paise)} still to come for ${formatMonth(data.month)}`
      }
    >
      {data.summary.active_student_count === 0 ? (
        <EmptyState
          title={`No students ${ahead ? 'are' : 'were'} coming in ${formatMonth(data.month)}.`}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={
            <span className="text-5xl" aria-hidden>
              🎉
            </span>
          }
          title={ahead ? `Everyone’s paid ahead for ${name}!` : `Everyone’s paid for ${name}!`}
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
              ahead={ahead}
              onLog={() =>
                openLogPayment({
                  studentId: item.student_id,
                  forMonth: data.month,
                  amountPaise: item.remaining_paise,
                  focusAfterSave: YET_TO_PAY_HEADING,
                })
              }
            />
          ))}
        </ul>
      )}
    </Panel>
  )
}

function YetToPayRow({
  item,
  ahead,
  onLog,
}: {
  item: YetToPayItem
  ahead: boolean
  onLog: () => void
}) {
  const partial = item.status === 'partial'
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 px-6 py-4 transition-colors hover:bg-muted/30 sm:flex-nowrap">
      <StudentAvatar name={item.student_name} />
      <div className="min-w-0 flex-1 basis-48 sm:basis-auto">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
          <Link
            to={`/students/${item.student_id}`}
            title={item.student_name}
            className="max-w-full truncate rounded text-base font-bold outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {item.student_name}
          </Link>
          {ahead ? (
            <StatusPill tone={partial ? 'credit' : 'muted'} className="h-6 px-2.5 text-xs">
              {partial ? 'Part paid ahead' : 'Not due yet'}
            </StatusPill>
          ) : (
            <StatusPill tone={partial ? 'partial' : 'owed'} className="h-6 px-2.5 text-xs">
              {partial ? 'Partial' : 'Unpaid'}
            </StatusPill>
          )}
        </div>
        {item.batch_label && (
          <p className="truncate text-sm text-muted-foreground">{item.batch_label}</p>
        )}
      </div>
      <div className="min-w-36 shrink-0 text-right">
        <p className="text-lg leading-tight font-extrabold tabular-nums">
          {formatRupees(item.remaining_paise)}
          <span className="ml-1 text-sm font-semibold text-muted-foreground">
            {ahead ? 'due' : 'left'}
          </span>
        </p>
        <p className="text-sm text-muted-foreground tabular-nums">
          {partial
            ? `${formatRupees(item.paid_paise + item.covered_by_credit_paise)} of ${formatRupees(item.expected_paise)} paid`
            : `Fee ${formatRupees(item.expected_paise)}`}
        </p>
      </div>
      <Button
        variant="outline"
        onClick={onLog}
        className="shrink-0 border-primary/60 bg-primary/10 hover:bg-primary/25"
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
      className="min-w-0"
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
                <div className="flex min-w-0 items-center gap-3">
                  <StudentAvatar name={item.student_name} size="sm" />
                  <span className="min-w-0 flex-1 truncate font-bold" title={item.student_name}>
                    {item.student_name}
                  </span>
                  <span className={cn('shrink-0 font-extrabold tabular-nums', TONE_TEXT.owed)}>
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

// ---- Extra money used ---------------------------------------------------------------------------

/**
 * Extra money that moved into or out of this month (PRD ledger rule 10): a payment above its
 * month's fee pays the oldest months still owed. Shown so a month paid "without a payment",
 * or a payment counted for less than was typed, is never a surprise.
 */
function CreditMoves({ items }: { items: CreditMoveItem[] }) {
  // One row per payment (same-day payments for the same month together), however many months
  // it paid: a slip of ₹45,000 is one row "→ Oct 2026 to Sep 2028", not 24.
  const groups = groupMoves(items)
  return (
    <Panel
      className="min-w-0"
      title="Extra money used"
      count={groups.length}
      description="Money that paid a different month than it was logged for."
    >
      <ul className="divide-y divide-border/70 border-t border-border/70">
        {groups.map((g) => (
          <li key={g.key}>
            <Link
              to={`/students/${g.student_id}`}
              className="flex min-w-0 items-center gap-3 px-6 py-3.5 transition-colors outline-none hover:bg-muted/30 focus-visible:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <StudentAvatar name={g.student_name} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-bold" title={g.student_name}>
                  {g.student_name}
                </span>
                <span className="block text-sm text-muted-foreground tabular-nums">
                  {formatRupees(g.amount_paise)} extra from the {formatDate(g.paid_on)}{' '}
                  {g.payment_ids.length > 1 ? 'payments' : 'payment'} for{' '}
                  {formatMonthShort(g.from_month)}
                </span>
                {g.needs_check && (
                  <span className="block text-sm font-semibold text-partial">
                    {g.payment_ids.length > 1
                      ? `Check: these payments pay up to ${formatMonthShort(g.pays_until)}`
                      : checkText({
                          amount_paise: g.payment_amount_paise,
                          for_month: g.from_month,
                          paysUntil: g.pays_until,
                          fee: 0,
                        })}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  'inline-flex max-w-[45%] shrink-0 items-center gap-1 text-right font-extrabold',
                  TONE_TEXT.credit,
                )}
              >
                <ArrowRightIcon className="size-4 shrink-0" aria-label="pays" />
                {monthRanges(g.to_months)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

/**
 * Why Collected differs from the Payments page's total for this month (what was logged for it):
 * extra money from other months' payments counts here, and money logged for this month that
 * paid other months counts there.
 */
function CollectedNote({ summary, name }: { summary: DashboardResponse['summary']; name: string }) {
  const kept =
    summary.logged_paise -
    summary.sent_elsewhere_paise -
    (summary.collected_paise - summary.covered_by_credit_paise)
  const lines = [
    summary.covered_by_credit_paise > 0 &&
      `Includes ${formatRupees(summary.covered_by_credit_paise)} of extra money from other months’ payments.`,
    summary.sent_elsewhere_paise > 0 &&
      `${formatRupees(summary.sent_elsewhere_paise)} logged for ${name} paid other months.`,
    kept > 0 && `${formatRupees(kept)} logged for ${name} is kept as credit.`,
  ].filter(Boolean)
  if (lines.length === 0) return null
  return (
    <span className="mt-1.5 block text-xs text-muted-foreground">
      {lines.map((line) => (
        <span key={String(line)} className="block">
          {line}
        </span>
      ))}
    </span>
  )
}

// ---- Credit -------------------------------------------------------------------------------------

/** Extra money that no month needed (everything owed is paid): kept as credit. */
function Credit({ items }: { items: OverpaidItem[] }) {
  return (
    <Panel
      className="min-w-0"
      title="Extra kept as credit"
      count={items.length}
      description="Nothing is owed for it to pay. Check the payment if it was a mistake."
    >
      <ul className="divide-y divide-border/70 border-t border-border/70">
        {items.map((item) => (
          <li key={`${item.student_id}-${item.month}`}>
            <Link
              to={`/students/${item.student_id}`}
              className="flex min-w-0 items-center gap-3 px-6 py-3.5 transition-colors outline-none hover:bg-muted/30 focus-visible:bg-muted/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <StudentAvatar name={item.student_name} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-bold" title={item.student_name}>
                  {item.student_name}
                </span>
                <span className="block text-sm text-muted-foreground tabular-nums">
                  {formatMonth(item.month)} · paid {formatRupees(item.paid_paise)}
                  {item.expected_paise > 0 ? `, fee ${formatRupees(item.expected_paise)}` : ''}
                </span>
              </span>
              <span
                className={cn(
                  'shrink-0 font-extrabold whitespace-nowrap tabular-nums',
                  TONE_TEXT.credit,
                )}
              >
                +{formatRupees(item.extra_unused_paise)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function QuietEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 border-t border-border/70 px-6 py-5 text-base text-muted-foreground">
      <CheckCircle2Icon className="size-5 shrink-0 text-paid" aria-hidden />
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
