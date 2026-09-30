/**
 * The monthly report's words, filters, sorting and totals (the Report page). The rows and their
 * numbers come from the server (`GET /api/report`); nothing here changes a number, it only
 * picks, orders and adds up rows.
 */
import type { ReportRow, ReportStatus, ReportTotals } from '@/api/types'
import { formatMonth } from '@/lib/format'
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
  paid_with_credit: { label: 'Paid with credit', tone: 'paid' },
  paid: { label: 'Paid', tone: 'paid' },
  no_fee: { label: 'No fee', tone: 'muted' },
  left: { label: 'Left', tone: 'muted' },
}

/** `owing`: everyone with something left to pay for the month (Unpaid, Partial, Not due yet). */
export type StatusFilter = 'all' | 'owing' | ReportStatus

export const STATUS_FILTERS: readonly StatusFilter[] = ['all', 'owing', ...REPORT_STATUSES]

export function isStatusFilter(value: string | null): value is StatusFilter {
  return value !== null && (STATUS_FILTERS as readonly string[]).includes(value)
}

export function statusFilterLabel(filter: StatusFilter): string {
  if (filter === 'all') return 'Everyone'
  if (filter === 'owing') return 'Not fully paid'
  return REPORT_STATUS[filter].label
}

export function matchesStatus(row: ReportRow, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'owing') return row.short_paise > 0
  return row.status === filter
}

/** The rows with this status that match the search (name, class, phone), in the same order. */
export function filterRows(rows: ReportRow[], filter: StatusFilter, search: string): ReportRow[] {
  return rows.filter(
    (r) =>
      matchesStatus(r, filter) &&
      studentMatches({ name: r.student_name, phone: r.phone, batch_label: r.batch_label }, search),
  )
}

export type ReportSortKey =
  | 'student'
  | 'batch'
  | 'fee'
  | 'paid'
  | 'covered'
  | 'extra'
  | 'short'
  | 'status'
  | 'owed_before'
  | 'owed_now'
  | 'credit'

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

/** The Excel download for a month: every student, whatever is filtered on screen. */
export function reportDownloadUrl(month: string): string {
  return `/api/report.xlsx?month=${encodeURIComponent(month)}`
}

/** "Scrappy Records — Fees report, October 2026": the printed page's (and the file's) title. */
export function reportTitle(month: string): string {
  return `Scrappy Records — Fees report, ${formatMonth(month)}`
}
