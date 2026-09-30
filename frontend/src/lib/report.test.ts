import type { ReportRow } from '@/api/types'
import { demoFixture } from '@/mocks/fixtures'
import { mockDb } from '@/mocks/node'
import { TEST_NOW } from '@/test/render'

import {
  filterRows,
  formatMonthList,
  isStatusFilter,
  reportDownloadUrl,
  reportTitle,
  sortRows,
  statusFilterLabel,
  sumRows,
} from './report'

function row(fields: Partial<ReportRow> & Pick<ReportRow, 'student_id' | 'student_name'>) {
  return {
    batch_label: null,
    phone: null,
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
  it('filters by status, and "Not fully paid" means something is short', () => {
    expect(filterRows(rows, 'all', '')).toEqual(rows)
    expect(filterRows(rows, 'unpaid', '')).toEqual([kabir])
    expect(filterRows(rows, 'owing', '')).toEqual([kabir, diya])
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
    expect(isStatusFilter('owing')).toBe(true)
    expect(isStatusFilter('nonsense')).toBe(false)
    expect(isStatusFilter(null)).toBe(false)
    expect(statusFilterLabel('all')).toBe('Everyone')
    expect(statusFilterLabel('paid_with_credit')).toBe('Paid with credit')
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
        expect(report.totals.owed_before_paise).toBe(
          board.backlog.reduce((sum, b) => sum + b.total_owed_paise, 0),
        )
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

it('names the download and the printed page', () => {
  expect(reportDownloadUrl('2026-10')).toBe('/api/report.xlsx?month=2026-10')
  expect(reportTitle('2026-10')).toBe('Scrappy Records — Fees report, October 2026')
})

it('lists months in short, with the year once per year', () => {
  expect(formatMonthList(['2026-06', '2026-07', '2026-08'])).toBe('Jun, Jul, Aug 2026')
  expect(formatMonthList(['2025-12', '2026-01'])).toBe('Dec 2025, Jan 2026')
  expect(formatMonthList(['2026-04'])).toBe('Apr 2026')
  expect(formatMonthList([])).toBe('')
})
