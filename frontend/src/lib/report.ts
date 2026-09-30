/**
 * The monthly report's words, filters, sorting and totals (the Report page). The rows and their
 * numbers come from the server (`GET /api/report`); nothing here changes a number, it only
 * picks, orders and adds up rows. The Excel download does the same on the server
 * (`backend/app/services/report.py` `shown`), so the file has the rows on screen.
 */
import type {
  ReportFilter,
  ReportRow,
  ReportSort as SortKey,
  ReportStatus,
  ReportTotals,
} from '@/api/types'
import { addMonths, formatMonth, formatMonthShort } from '@/lib/format'
import { fold, studentMatches } from '@/lib/search'
import type { Tone } from '@/lib/status'

/** The server's order: whom to follow up with first. */
export const REPORT_STATUSES: readonly ReportStatus[] = [
  'unpaid',
  'partial',
  'not_due_yet',
  'paid_with_credit',
  'paid',
  'no_fee',
  'left',
]

/** The words and colours for each status (the Excel file uses the same words). */
export const REPORT_STATUS: Record<ReportStatus, { label: string; tone: Tone }> = {
  unpaid: { label: 'Unpaid', tone: 'owed' },
  partial: { label: 'Partial', tone: 'partial' },
  not_due_yet: { label: 'Not due yet', tone: 'muted' },
  paid_with_credit: { label: 'Paid (from extra)', tone: 'paid' },
  paid: { label: 'Paid', tone: 'paid' },
  no_fee: { label: 'No fee', tone: 'muted' },
  left: { label: 'Left', tone: 'muted' },
}

/** A row's status in words: "Left after May 2026", "Away (no fee)", "Not joined yet". */
export function statusLabel(
  row: Pick<ReportRow, 'status' | 'left_month' | 'no_fee_reason'>,
): string {
  if (row.status === 'left' && row.left_month) return `Left after ${formatMonth(row.left_month)}`
  if (row.status === 'no_fee' && row.no_fee_reason === 'not_joined') return 'Not joined yet'
  if (row.status === 'no_fee' && row.no_fee_reason === 'away') return 'Away (no fee)'
  return REPORT_STATUS[row.status].label
}

/** The small line under a status pill: "after May 2026", "Away", "Not joined yet". */
export function statusDetail(
  row: Pick<ReportRow, 'status' | 'left_month' | 'no_fee_reason'>,
): string | null {
  if (row.status === 'left' && row.left_month) return `after ${formatMonth(row.left_month)}`
  if (row.status === 'no_fee' && row.no_fee_reason === 'not_joined') return 'Not joined yet'
  if (row.status === 'no_fee' && row.no_fee_reason === 'away') return 'Away'
  return null
}

/**
 * The status list: `owes` is anyone owing anything now (Total owed now above ₹0), the list to
 * chase; `short` is anyone with something left to pay for this month.
 */
export type StatusFilter = ReportFilter

export const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'owes', 'short', ...REPORT_STATUSES]

export function isStatusFilter(value: string | null): value is StatusFilter {
  return value !== null && (STATUS_FILTERS as readonly string[]).includes(value)
}

/** Which month the report is for, and the server's current month. */
export interface ReportMonth {
  month: string
  current_month: string
}

/** For a past month, "Owes anything" is "Still owes for Aug 2026 or earlier". */
export function statusFilterLabel(filter: StatusFilter, when?: ReportMonth): string {
  if (filter === 'all') return 'Everyone'
  if (filter === 'owes') {
    return when && when.month < when.current_month
      ? `Still owes for ${formatMonthShort(when.month)} or earlier`
      : 'Owes anything'
  }
  if (filter === 'short') return 'Short this month'
  return REPORT_STATUS[filter].label
}

/**
 * `owes`: anything still owed, as of today, for the month or an earlier one. From the current
 * month on that's everything owed now; for a past month, debts that started after it don't
 * count (backend `report.owes_through_month`).
 */
export function owesThroughMonth(row: ReportRow, when?: ReportMonth): boolean {
  if (when && when.month < when.current_month) return row.owed_before_paise + row.short_paise > 0
  return row.owed_now_paise > 0
}

export function matchesStatus(row: ReportRow, filter: StatusFilter, when?: ReportMonth): boolean {
  if (filter === 'all') return true
  if (filter === 'owes') return owesThroughMonth(row, when)
  if (filter === 'short') return row.short_paise > 0
  return row.status === filter
}

/** The rows with this status that match the search (name, class, phone), in the same order. */
export function filterRows(
  rows: ReportRow[],
  filter: StatusFilter,
  search: string,
  when?: ReportMonth,
): ReportRow[] {
  return rows.filter(
    (r) =>
      matchesStatus(r, filter, when) &&
      studentMatches({ name: r.student_name, phone: r.phone, batch_label: r.batch_label }, search),
  )
}

export type ReportSortKey = SortKey

export interface ReportSort {
  key: ReportSortKey
  desc: boolean
}

const statusRank = (r: ReportRow) => REPORT_STATUSES.indexOf(r.status)

const SORT_VALUE: Record<ReportSortKey, (r: ReportRow) => string | number> = {
  student: (r) => fold(r.student_name),
  batch: (r) => fold(r.batch_label ?? ''),
  fee: (r) => r.fee_paise,
  paid: (r) => r.paid_paise,
  covered: (r) => r.covered_by_credit_paise,
  extra: (r) => r.extra_sent_paise + r.extra_unused_paise,
  short: (r) => r.short_paise,
  status: statusRank,
  owed_before: (r) => r.owed_before_paise,
  owed_now: (r) => r.owed_now_paise,
  credit: (r) => r.credit_paise + r.paid_ahead_paise,
}

const compare = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0)

/** The server's order: status (unpaid first), then name. */
function defaultOrder(a: ReportRow, b: ReportRow): number {
  return (
    compare(statusRank(a), statusRank(b)) ||
    compare(fold(a.student_name), fold(b.student_name)) ||
    a.student_id - b.student_id
  )
}

/** Sorted by a column (ties in the usual order), or as the server sent them when there's no
 * sort (the usual order). */
export function sortRows(rows: ReportRow[], sort: ReportSort | null): ReportRow[] {
  if (!sort) return rows
  const value = SORT_VALUE[sort.key]
  const sign = sort.desc ? -1 : 1
  return [...rows].sort((a, b) => sign * compare(value(a), value(b)) || defaultOrder(a, b))
}

/** The totals row: the same sums as the server's `totals` (and the dashboard), for these rows. */
export function sumRows(rows: ReportRow[]): ReportTotals {
  const total = (pick: (r: ReportRow) => number) => rows.reduce((sum, r) => sum + pick(r), 0)
  return {
    student_count: rows.length,
    fee_paise: total((r) => r.fee_paise),
    paid_paise: total((r) => r.paid_paise),
    paid_direct_paise: total((r) => r.paid_direct_paise),
    covered_by_credit_paise: total((r) => r.covered_by_credit_paise),
    collected_paise: total((r) => r.paid_direct_paise + r.covered_by_credit_paise),
    extra_sent_paise: total((r) => r.extra_sent_paise),
    extra_unused_paise: total((r) => r.extra_unused_paise),
    short_paise: total((r) => r.short_paise),
    owed_before_paise: total((r) => r.owed_before_paise),
    owed_now_paise: total((r) => r.owed_now_paise),
    credit_paise: total((r) => r.credit_paise),
    paid_ahead_paise: total((r) => r.paid_ahead_paise),
    not_fully_paid_count: rows.filter((r) => r.short_paise > 0).length,
    active_student_count: rows.filter((r) => r.is_enrolled && r.fee_paise > 0).length,
  }
}

/** The Excel download: the rows on screen (the status list, the search and the sort). */
export function reportDownloadUrl(
  month: string,
  shown: { filter?: StatusFilter; search?: string; sort?: ReportSort | null } = {},
): string {
  const query = new URLSearchParams({ month })
  if (shown.filter && shown.filter !== 'all') query.set('status', shown.filter)
  if (shown.search?.trim()) query.set('q', shown.search.trim())
  if (shown.sort) {
    query.set('sort', shown.sort.key)
    query.set('order', shown.sort.desc ? 'desc' : 'asc')
  }
  return `/api/report.xlsx?${query.toString()}`
}

/** "Scrappy Records — Fees report, October 2026": the printed page's (and the file's) title. */
export function reportTitle(month: string): string {
  return `Scrappy Records — Fees report, ${formatMonth(month)}`
}

/**
 * Months owed, a run of months at a time, so a long list stays short (also in Excel):
 * "Apr 2026", "Jan–Jun 2026 (6 months)", "Dec 2025–Feb 2026 (3 months), Apr 2026".
 */
export function formatMonthRuns(months: readonly string[]): string {
  const runs: string[][] = []
  for (const m of months) {
    const last = runs.at(-1)
    if (last && addMonths(last.at(-1)!, 1) === m) last.push(m)
    else runs.push([m])
  }
  return runs
    .map((run) => {
      const first = run[0]!
      const last = run.at(-1)!
      if (run.length === 1) return formatMonthShort(first)
      const start =
        first.slice(0, 4) === last.slice(0, 4)
          ? formatMonthShort(first).split(' ')[0]
          : formatMonthShort(first)
      return `${start}–${formatMonthShort(last)} (${run.length} months)`
    })
    .join(', ')
}

/**
 * Where a month's extra went, a run of months at a time (also in Excel): "₹1,500 → Aug 2026",
 * "₹13,500 → Oct 2026–Jun 2027 (9 months)".
 */
export function extraRuns(
  sent: readonly { to_month: string; amount_paise: number }[],
): { key: string; amount_paise: number; months: string }[] {
  const runs: { to_month: string; amount_paise: number }[][] = []
  for (const e of sent) {
    const last = runs.at(-1)
    if (last && addMonths(last.at(-1)!.to_month, 1) === e.to_month) last.push(e)
    else runs.push([e])
  }
  return runs.map((run) => ({
    key: run[0]!.to_month,
    amount_paise: run.reduce((sum, e) => sum + e.amount_paise, 0),
    months: formatMonthRuns(run.map((e) => e.to_month)),
  }))
}
