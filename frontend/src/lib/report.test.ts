import type { ReportRow } from '@/api/types'
import { demoFixture } from '@/mocks/fixtures'
import { mockDb } from '@/mocks/node'
import { TEST_NOW } from '@/test/render'

import {
  filterRows,
  formatMonthRuns,
  isStatusFilter,
  reportDownloadUrl,
  statusDetail,
  statusLabel,
  reportTitle,
  sortRows,
  statusFilterLabel,
  sumRows,
} from './report'

function row(fields: Partial<ReportRow> & Pick<ReportRow, 'student_id' | 'student_name'>) {
  return {
    batch_label: null,
    phone: null,
    joined_month: '2026-01',
    left_month: null,
    is_enrolled: true,
    fee_paise: 150000,
    paid_paise: 0,
    paid_direct_paise: 0,
    covered_by_credit_paise: 0,
    credit_sources: [],
    extra_sent_paise: 0,
    extra_sent: [],
    extra_unused_paise: 0,
    short_paise: 150000,
    status: 'unpaid',
    no_fee_reason: null,
    checks: [],
    owed_before_paise: 0,
    owed_before_months: [],
    owed_now_paise: 150000,
    credit_paise: 0,
    paid_ahead_paise: 0,
    ...fields,
  } satisfies ReportRow
}

const kabir = row({ student_id: 1, student_name: 'Kabir Mehta', phone: '98765 43210' })
const diya = row({
  student_id: 2,
  student_name: 'Diya Sharma',
  batch_label: 'Tue/Thu 5pm',
  status: 'partial',
  paid_paise: 100000,
  paid_direct_paise: 100000,
  short_paise: 50000,
  owed_now_paise: 50000,
})
const ananya = row({
  student_id: 3,
  student_name: 'Ananya Rao',
  status: 'paid',
  paid_paise: 300000,
  paid_direct_paise: 150000,
  extra_sent_paise: 150000,
  extra_sent: [{ to_month: '2026-09', amount_paise: 150000 }],
  short_paise: 0,
  owed_now_paise: 0,
})
const zoya = row({
  student_id: 4,
  student_name: 'Zoya Khan',
  status: 'no_fee',
  fee_paise: 0,
  short_paise: 0,
  owed_now_paise: 0,
})
const rows = [kabir, diya, ananya, zoya]

describe('report filters', () => {
  it('filters by status: "Owes anything" is any money owed now, "Short this month" is this month', () => {
    expect(filterRows(rows, 'all', '')).toEqual(rows)
    expect(filterRows(rows, 'unpaid', '')).toEqual([kabir])
    expect(filterRows(rows, 'short', '')).toEqual([kabir, diya])
    // Paid this month, but owes an earlier one: on the chase list, not short this month.
    const owesEarlier = {
      ...ananya,
      student_id: 5,
      owed_before_paise: 90000,
      owed_now_paise: 90000,
    }
    expect(filterRows([...rows, owesEarlier], 'owes', '')).toEqual([kabir, diya, owesEarlier])
    expect(filterRows([...rows, owesEarlier], 'short', '')).toEqual([kabir, diya])
    expect(filterRows(rows, 'paid_with_credit', '')).toEqual([])
  })

  it('searches names, classes and phone numbers like the rest of the app', () => {
    expect(filterRows(rows, 'all', 'kabir')).toEqual([kabir])
    expect(filterRows(rows, 'all', 'rao ananya')).toEqual([ananya])
    expect(filterRows(rows, 'all', '9876543210')).toEqual([kabir])
    expect(filterRows(rows, 'all', 'tue/thu')).toEqual([diya])
    expect(filterRows(rows, 'paid', 'kabir')).toEqual([])
  })

  it('reads the status filter from the address', () => {
    expect(isStatusFilter('unpaid')).toBe(true)
    expect(isStatusFilter('owes')).toBe(true)
    expect(isStatusFilter('owing')).toBe(false)
    expect(isStatusFilter('nonsense')).toBe(false)
    expect(isStatusFilter(null)).toBe(false)
    expect(statusFilterLabel('all')).toBe('Everyone')
    expect(statusFilterLabel('paid_with_credit')).toBe('Paid (from extra)')
    expect(statusFilterLabel('owes')).toBe('Owes anything')
    expect(statusFilterLabel('short')).toBe('Short this month')
  })
})

describe('report sorting', () => {
  it('keeps the server order until a column is chosen', () => {
    expect(sortRows(rows, null)).toBe(rows)
  })

  it('sorts by a column, ties in the usual order', () => {
    expect(sortRows(rows, { key: 'short', desc: true }).map((r) => r.student_id)).toEqual([
      1, 2, 3, 4,
    ])
    expect(sortRows(rows, { key: 'student', desc: false }).map((r) => r.student_name)).toEqual([
      'Ananya Rao',
      'Diya Sharma',
      'Kabir Mehta',
      'Zoya Khan',
    ])
    expect(sortRows(rows, { key: 'extra', desc: true })[0]).toBe(ananya)
    // Status: unpaid first, as the report starts.
    expect(sortRows([zoya, ananya, diya, kabir], { key: 'status', desc: false })).toEqual(rows)
  })
})

describe('report totals', () => {
  it('adds up the rows shown', () => {
    const t = sumRows([kabir, diya, ananya, zoya])
    expect(t).toMatchObject({
      student_count: 4,
      fee_paise: 450000,
      paid_paise: 400000,
      collected_paise: 250000,
      extra_sent_paise: 150000,
      short_paise: 200000,
      owed_now_paise: 200000,
      not_fully_paid_count: 2,
      active_student_count: 3, // Zoya's ₹0 fee isn't counted
    })
  })

  it('matches the server totals and the dashboard summary for every month', () => {
    mockDb.reset(demoFixture(TEST_NOW))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(TEST_NOW)
    try {
      for (const month of ['2025-12', '2026-06', '2026-09', '2026-10', '2026-11', '2027-01']) {
        const report = mockDb.report(month)
        const board = mockDb.dashboard(month)
        expect(sumRows(report.rows)).toEqual(report.totals)
        expect(report.totals.fee_paise).toBe(board.summary.expected_paise)
        expect(report.totals.collected_paise).toBe(board.summary.collected_paise)
        expect(report.totals.short_paise).toBe(board.summary.still_due_paise)
        expect(report.totals.not_fully_paid_count).toBe(board.summary.not_fully_paid_count)
        expect(report.totals.active_student_count).toBe(board.summary.active_student_count)
        expect(report.totals.paid_paise).toBe(board.summary.logged_paise)
        expect(report.totals.covered_by_credit_paise).toBe(board.summary.covered_by_credit_paise)
        expect(report.totals.extra_sent_paise).toBe(board.summary.sent_elsewhere_paise)
        expect(report.totals.owed_before_paise).toBe(
          board.backlog.reduce((sum, b) => sum + b.total_owed_paise, 0),
        )
      }
      // This month's report has everyone the Students list shows owing, with credit or ahead.
      const students = mockDb.listStudents('all')
      const current = mockDb.report('2026-10').totals
      const sum = (pick: (s: (typeof students)[number]) => number) =>
        students.reduce((total, s) => total + pick(s), 0)
      expect(current.owed_now_paise).toBe(sum((s) => s.owed_paise))
      expect(current.credit_paise).toBe(sum((s) => s.credit_paise))
      expect(current.paid_ahead_paise).toBe(sum((s) => s.paid_ahead_paise))
      expect(current.credit_paise).toBeGreaterThan(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

it('names the download and the printed page', () => {
  expect(reportDownloadUrl('2026-10')).toBe('/api/report.xlsx?month=2026-10')
  // The download follows what's on screen.
  expect(
    reportDownloadUrl('2026-10', {
      filter: 'owes',
      search: ' rao ',
      sort: { key: 'owed_now', desc: true },
    }),
  ).toBe('/api/report.xlsx?month=2026-10&status=owes&q=rao&sort=owed_now&order=desc')
  expect(reportDownloadUrl('2026-10', { filter: 'all', search: '', sort: null })).toBe(
    '/api/report.xlsx?month=2026-10',
  )
  expect(reportTitle('2026-10')).toBe('Scrappy Records — Fees report, October 2026')
})

it('keeps many months owed short: runs of months', () => {
  expect(formatMonthRuns(['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'])).toBe(
    'Jan–Jun 2026 (6 months)',
  )
  expect(formatMonthRuns(['2025-12', '2026-01', '2026-02', '2026-04'])).toBe(
    'Dec 2025–Feb 2026 (3 months), Apr 2026',
  )
  expect(formatMonthRuns(['2026-04'])).toBe('Apr 2026')
  expect(formatMonthRuns([])).toBe('')
})

it('says when they left and why there is no fee', () => {
  const left = { status: 'left', left_month: '2026-05', no_fee_reason: null } as const
  expect(statusLabel(left)).toBe('Left after May 2026')
  expect(statusDetail(left)).toBe('after May 2026')
  const away = { status: 'no_fee', left_month: null, no_fee_reason: 'away' } as const
  expect(statusLabel(away)).toBe('Away (no fee)')
  const before = { status: 'no_fee', left_month: null, no_fee_reason: 'not_joined' } as const
  expect(statusLabel(before)).toBe('Not joined yet')
  const free = { status: 'no_fee', left_month: null, no_fee_reason: 'zero_fee' } as const
  expect(statusLabel(free)).toBe('No fee')
  expect(statusDetail(free)).toBeNull()
  expect(statusLabel({ status: 'paid_with_credit', left_month: null, no_fee_reason: null })).toBe(
    'Paid (from extra)',
  )
})
