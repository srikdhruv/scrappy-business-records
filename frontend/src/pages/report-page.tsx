/**
 * The monthly report (`/report?month=YYYY-MM`, opened from the Dashboard): every student for one
 * month. The answers come first (status, fee, paid, short, total owed now), then the details
 * (extra money in and out, earlier months, credit), then class and phone. Filter by status,
 * search by name, sort by a column; the totals row and the Collected line add up the rows shown.
 * Download Excel gives the same rows as a file, and Print gives a clean A4 landscape page (see
 * the `@media print` rules in index.css).
 *
 * Every number comes from the server (`GET /api/report`), which works it out from the same
 * ledger as the Dashboard and the profiles, so they always agree.
 */
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  FileDownIcon,
  PrinterIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'

import { useReport } from '@/api/queries'
import type { ReportRow, ReportTotals } from '@/api/types'
import { PageHeader } from '@/components/layout/page-header'
import { MonthNote, MonthSwitcher } from '@/components/month-switcher'
import { Panel } from '@/components/panel'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/states'
import { StatusPill } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { checkText, creditFromText, creditSourceText } from '@/lib/credit'
import { formatDate, formatMonth, formatRupees } from '@/lib/format'
import { plural } from '@/lib/labels'
import {
  REPORT_STATUS,
  STATUS_FILTERS,
  extraRuns,
  filterRows,
  formatMonthRuns,
  isStatusFilter,
  matchesStatus,
  reportDownloadUrl,
  reportTitle,
  sortRows,
  statusDetail,
  statusFilterLabel,
  sumRows,
  type ReportSort,
  type ReportSortKey,
  type StatusFilter,
} from '@/lib/report'
import { TONE_TEXT } from '@/lib/status'
import { cn } from '@/lib/utils'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

// The Student column stays in view while the table scrolls sideways.
const STICKY = 'sticky left-0 z-[1] bg-card shadow-[inset_-1px_0_0_var(--border)] print:static'

export function ReportPage() {
  const [params, setParams] = useSearchParams()
  const requested = params.get('month')
  const chosen = requested && MONTH_RE.test(requested) ? requested : undefined
  const statusParam = params.get('status')
  const filter: StatusFilter = isStatusFilter(statusParam) ? statusParam : 'all'
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<ReportSort | null>(null)

  const report = useReport(chosen)
  const data = report.data
  const now = data?.current_month
  const month = chosen ?? data?.month

  function update(changes: Record<string, string | null>) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(changes)) {
          if (value === null || value === '' || value === 'all') next.delete(key)
          else next.set(key, value)
        }
        return next
      },
      { replace: true },
    )
  }

  const rows = useMemo(
    () => (data ? sortRows(filterRows(data.rows, filter, search, data), sort) : []),
    [data, filter, search, sort],
  )
  const totals = useMemo(() => sumRows(rows), [rows])
  const filtered = filter !== 'all' || search.trim() !== ''
  const everyone = data?.rows.length ?? 0
  const ahead = data ? data.month > data.current_month : false

  return (
    <>
      {data && (
        <div className="mb-3 hidden print:block">
          <p className="text-xl font-extrabold">{reportTitle(data.month)}</p>
          <p className="text-sm text-muted-foreground">
            Printed on {formatDate(data.today)}
            {filtered &&
              ` · Showing ${rows.length} of ${plural(everyone, 'student')}: ${[
                filter !== 'all' ? statusFilterLabel(filter, data) : '',
                search.trim() ? `matching “${search.trim()}”` : '',
              ]
                .filter(Boolean)
                .join(', ')}`}
          </p>
        </div>
      )}

      <div className="print:hidden">
        <PageHeader
          eyebrow={
            <Link
              to={month && month !== now ? `/?month=${month}` : '/'}
              className="inline-flex items-center gap-1.5 rounded outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <ArrowLeftIcon className="size-4" aria-hidden />
              Dashboard · Monthly report
            </Link>
          }
          title={<MonthSwitcher month={month} onChange={(m) => update({ month: m })} />}
          description={
            <MonthNote
              month={month}
              now={now}
              current="Every student this month: what they paid, and what’s still owed."
              onBack={() => now && update({ month: now })}
            />
          }
          actions={
            data && (
              <>
                <Button variant="outline" asChild className="bg-card">
                  <a href={reportDownloadUrl(data.month, { filter, search, sort })} download>
                    <FileDownIcon className="text-primary-strong" aria-hidden />
                    Download Excel
                  </a>
                </Button>
                <Button variant="outline" className="bg-card" onClick={() => window.print()}>
                  <PrinterIcon className="text-primary-strong" aria-hidden />
                  Print
                </Button>
              </>
            )
          }
        />
      </div>

      {report.error && !data ? (
        <ErrorState error={report.error} onRetry={() => void report.refetch()} />
      ) : !data ? (
        <Panel>
          <div className="p-6" aria-busy="true" aria-label="Loading the report">
            <ListSkeleton rows={8} />
          </div>
        </Panel>
      ) : (
        <Panel
          bodyClassName="pt-0"
          className={cn(
            'report-sheet transition-opacity print:rounded-none print:border-0 print:bg-transparent print:shadow-none',
            report.isPlaceholderData && 'opacity-60',
          )}
        >
          <div
            className="flex flex-wrap items-end gap-3 border-b border-border/70 px-6 py-5 print:hidden"
            role="search"
            aria-label="Filter the report"
          >
            <div className="relative min-w-56 flex-[2_1_14rem]">
              <SearchIcon
                className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name"
                aria-label="Search the report by name, class or phone"
                className="pl-10"
              />
            </div>
            <div className="min-w-48 flex-[1_1_12rem]">
              <Select value={filter} onValueChange={(v) => update({ status: v })}>
                <SelectTrigger className="h-11! w-full bg-card text-base" aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_FILTERS.map((f) => {
                    const count = data.rows.filter((r) => matchesStatus(r, f, data)).length
                    const always = f === 'all' || f === 'owes' || f === 'short'
                    if (count === 0 && !always && f !== filter) return null
                    return (
                      <SelectItem key={f} value={f}>
                        {statusFilterLabel(f, data)} ({count})
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
            {filtered && (
              <Button
                variant="ghost"
                onClick={() => {
                  setSearch('')
                  update({ status: null })
                }}
                className="h-11"
              >
                <XIcon aria-hidden />
                Clear filters
              </Button>
            )}
            {filtered && (
              <p className="w-full text-sm text-muted-foreground" aria-live="polite">
                Showing {rows.length} of {plural(everyone, 'student')}. The totals, Print and
                Download Excel have just these.
              </p>
            )}
          </div>

          {everyone === 0 ? (
            <EmptyState title={`No students for ${formatMonth(data.month)}.`}>
              Nobody was enrolled then, and no money was paid for it.
            </EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState title="Nobody matches.">
              Try another search, or clear the filters.
            </EmptyState>
          ) : (
            <>
              <ReportTable
                rows={rows}
                totals={totals}
                filtered={filtered}
                ahead={ahead}
                sort={sort}
                onSort={setSort}
              />
              <Collected totals={totals} month={data.month} ahead={ahead} filtered={filtered} />
            </>
          )}
        </Panel>
      )}
    </>
  )
}

/**
 * The Dashboard's headline for the rows shown: what pays the month. It's what was paid for the
 * month, less the extra that went to other months or was kept as credit, plus what other
 * payments' extra paid.
 */
function Collected({
  totals: t,
  month,
  ahead,
  filtered,
}: {
  totals: ReportTotals
  month: string
  ahead: boolean
  filtered: boolean
}) {
  const parts = [
    `${formatRupees(t.paid_paise)} paid for this month`,
    t.extra_sent_paise > 0 && `less ${formatRupees(t.extra_sent_paise)} sent to other months`,
    t.extra_unused_paise > 0 && `less ${formatRupees(t.extra_unused_paise)} kept as credit`,
    t.covered_by_credit_paise > 0 &&
      `plus ${formatRupees(t.covered_by_credit_paise)} from other payments’ extra`,
  ].filter(Boolean)
  return (
    <div className="space-y-1 border-t border-border/70 px-6 py-4 text-sm text-muted-foreground print:px-0 print:py-2">
      <p>
        <strong className="text-foreground">
          {ahead ? 'Paid ahead' : 'Collected'} for {formatMonth(month)}
          {filtered ? ' (the students shown)' : ''}: {formatRupees(t.collected_paise)}
        </strong>
        {parts.length > 1 && ` = ${parts.join(', ')}`}
        {!filtered && ', as on the Dashboard'}.
      </p>
      <p>
        Payments count for the month they’re <em>for</em>, not the day they were paid.
      </p>
    </div>
  )
}

// ---- The table ----------------------------------------------------------------------------------

function ReportTable({
  rows,
  totals,
  filtered,
  ahead,
  sort,
  onSort,
}: {
  rows: ReportRow[]
  totals: ReportTotals
  filtered: boolean
  ahead: boolean
  sort: ReportSort | null
  onSort: (sort: ReportSort | null) => void
}) {
  const header = (key: ReportSortKey, label: ReactNode, align: 'left' | 'right' = 'right') => {
    const sorted = sort?.key === key ? (sort.desc ? 'desc' : 'asc') : false
    // Names and classes start A to Z, statuses unpaid first; amounts start with the largest.
    const firstDesc = key !== 'student' && key !== 'batch' && key !== 'status'
    const toggle = () => {
      if (!sorted) onSort({ key, desc: firstDesc })
      else if (sorted === (firstDesc ? 'desc' : 'asc')) onSort({ key, desc: !firstDesc })
      else onSort(null)
    }
    return <SortButton label={label} sorted={sorted} onToggle={toggle} align={align} />
  }
  const ariaSort = (key: ReportSortKey) =>
    sort?.key === key ? (sort.desc ? 'descending' : 'ascending') : undefined
  const head = (key: ReportSortKey, label: ReactNode, className?: string) => (
    <TableHead className={cn('text-right', className)} aria-sort={ariaSort(key)}>
      {header(key, label)}
    </TableHead>
  )

  return (
    <Table className="text-sm print:text-[9pt]">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className={cn(STICKY, 'min-w-36 pl-6')} aria-sort={ariaSort('student')}>
            {header('student', 'Student', 'left')}
          </TableHead>
          <TableHead aria-sort={ariaSort('status')}>{header('status', 'Status', 'left')}</TableHead>
          {head('fee', 'Fee')}
          {head('paid', <Wrap>Paid for this month</Wrap>)}
          {head('short', 'Short')}
          {head('owed_now', <Wrap>Total owed now</Wrap>)}
          {head('covered', <Wrap wide>Paid from another payment’s extra</Wrap>)}
          {head('extra', <Wrap wide>Extra sent elsewhere</Wrap>)}
          {head('owed_before', <Wrap wide>Owed from earlier months</Wrap>)}
          {head('credit', <Wrap wide>Kept as credit / paid ahead</Wrap>)}
          <TableHead aria-sort={ariaSort('batch')}>
            {header('batch', 'Class/batch', 'left')}
          </TableHead>
          <TableHead className="pr-6">Phone</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <Row key={r.student_id} row={r} />
        ))}
      </TableBody>
      <TableFooter className="bg-muted/60 font-bold">
        <TableRow className="hover:bg-transparent [&>td]:align-top">
          <TableCell className={cn(STICKY, 'bg-muted pl-6 whitespace-normal')}>
            {filtered
              ? `Total of the ${rows.length} shown`
              : `Total · ${plural(rows.length, 'student')}`}
          </TableCell>
          <TableCell className="font-semibold whitespace-normal">
            {totals.active_student_count > 0 &&
              `${totals.not_fully_paid_count} of ${totals.active_student_count} ${ahead ? 'not paid ahead' : 'not fully paid'}`}
          </TableCell>
          <MoneyCell paise={totals.fee_paise} />
          <MoneyCell paise={totals.paid_paise} />
          <MoneyCell paise={totals.short_paise} />
          <MoneyCell paise={totals.owed_now_paise} />
          <MoneyCell paise={totals.covered_by_credit_paise} />
          <MoneyCell paise={totals.extra_sent_paise}>
            {totals.extra_unused_paise > 0 && (
              <Note tone="credit">{formatRupees(totals.extra_unused_paise)} kept as credit</Note>
            )}
          </MoneyCell>
          <MoneyCell paise={totals.owed_before_paise} />
          <CreditCell credit={totals.credit_paise} ahead={totals.paid_ahead_paise} />
          <TableCell />
          <TableCell className="pr-6" />
        </TableRow>
      </TableFooter>
    </Table>
  )
}

function Row({ row: r }: { row: ReportRow }) {
  const { label, tone } = REPORT_STATUS[r.status]
  const owing = r.status === 'unpaid' || r.status === 'partial'
  const detail = statusDetail(r)
  return (
    <TableRow className="group break-inside-avoid [&>td]:align-top">
      <TableCell className={cn(STICKY, 'pl-6 whitespace-normal group-hover:bg-muted')}>
        <Link
          to={`/students/${r.student_id}`}
          title={r.student_name}
          className="block max-w-40 truncate rounded font-bold outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 print:max-w-none print:whitespace-normal"
        >
          {r.student_name}
        </Link>
      </TableCell>
      <TableCell>
        <StatusPill tone={tone} className="h-6 px-2.5 text-xs">
          {label}
        </StatusPill>
        {detail && (
          <span className="mt-0.5 block max-w-28 text-xs font-semibold whitespace-normal text-muted-foreground">
            {detail}
          </span>
        )}
      </TableCell>
      <MoneyCell paise={r.fee_paise} />
      <MoneyCell paise={r.paid_paise}>
        {r.checks.map((c) => (
          <Note key={c.payment_id} tone="check">
            {checkText({
              amount_paise: c.amount_paise,
              paysUntil: c.pays_until,
              monthsAhead: c.months_ahead,
              unused_paise: c.extra_unused_paise,
            })}
          </Note>
        ))}
      </MoneyCell>
      <MoneyCell
        paise={r.short_paise}
        className={cn(owing && 'font-bold', owing && TONE_TEXT[tone])}
      />
      <MoneyCell
        paise={r.owed_now_paise}
        className={cn(r.owed_now_paise > 0 && 'font-bold text-owed')}
      />
      <MoneyCell paise={r.covered_by_credit_paise}>
        {r.credit_sources.map((s) => (
          <Note key={`${s.payment_id}`} tone="credit">
            {r.credit_sources.length === 1 ? creditFromText(s) : creditSourceText(s)}
          </Note>
        ))}
      </MoneyCell>
      <MoneyCell paise={r.extra_sent_paise}>
        {extraRuns(r.extra_sent).map((run, _, runs) => (
          <Note key={run.key} tone="credit">
            {runs.length === 1 ? '' : `${formatRupees(run.amount_paise)} `}→ {run.months}
          </Note>
        ))}
        {r.extra_unused_paise > 0 && (
          <Note tone="credit">{formatRupees(r.extra_unused_paise)} kept as credit</Note>
        )}
      </MoneyCell>
      <MoneyCell paise={r.owed_before_paise} className={cn(r.owed_before_paise > 0 && 'text-owed')}>
        {r.owed_before_months.length > 0 && <Note>{formatMonthRuns(r.owed_before_months)}</Note>}
      </MoneyCell>
      <CreditCell credit={r.credit_paise} ahead={r.paid_ahead_paise} />
      <TableCell className="min-w-52 whitespace-normal text-muted-foreground">
        {r.batch_label}
      </TableCell>
      <TableCell className="print-nowrap pr-6 text-muted-foreground tabular-nums">
        {r.phone}
      </TableCell>
    </TableRow>
  )
}

// ---- Cells --------------------------------------------------------------------------------------

/** An amount, or a quiet "—" for nothing, with any notes under it. */
function MoneyCell({
  paise,
  className,
  children,
}: {
  paise: number
  className?: string
  children?: ReactNode
}) {
  return (
    <TableCell className={cn('text-right align-top tabular-nums', className)}>
      {paise === 0 ? <span className="text-muted-foreground/70">—</span> : formatRupees(paise)}
      {children}
    </TableCell>
  )
}

function CreditCell({ credit, ahead }: { credit: number; ahead: number }) {
  return (
    <TableCell className="text-right align-top tabular-nums">
      {credit === 0 && ahead === 0 && <span className="text-muted-foreground/70">—</span>}
      {credit > 0 && (
        <span className="block text-credit">{formatRupees(credit)} kept as credit</span>
      )}
      {ahead > 0 && <span className="block text-credit">{formatRupees(ahead)} paid ahead</span>}
    </TableCell>
  )
}

function Note({ children, tone }: { children: ReactNode; tone?: 'credit' | 'check' }) {
  return (
    <span
      className={cn(
        'ml-auto block max-w-48 min-w-36 text-xs font-semibold whitespace-normal print:min-w-0',
        tone === 'credit' && 'text-credit',
        tone === 'check' && 'text-partial',
        !tone && 'text-muted-foreground',
      )}
    >
      {children}
    </span>
  )
}

/** A heading that may wrap onto two or three lines, so the table stays narrow. */
function Wrap({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <span
      className={cn(
        'inline-block text-right whitespace-normal print:w-auto',
        wide ? 'w-28' : 'w-16',
      )}
    >
      {children}
    </span>
  )
}

function SortButton({
  label,
  sorted,
  onToggle,
  align,
}: {
  label: ReactNode
  sorted: false | 'asc' | 'desc'
  onToggle: () => void
  align: 'left' | 'right'
}) {
  const Icon = sorted === 'asc' ? ArrowUpIcon : sorted === 'desc' ? ArrowDownIcon : ArrowUpDownIcon
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          '-mx-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold transition-colors',
          'outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
          'print:hidden',
          sorted && 'text-foreground',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {label}
        <Icon className={cn('size-4 shrink-0', !sorted && 'opacity-40')} aria-hidden />
      </button>
      {/* Printed as plain words: Chrome doesn't draw buttons in headings repeated on page 2. */}
      <span className="hidden font-semibold print:inline" aria-hidden>
        {label}
      </span>
    </>
  )
}
