/** The mock API's ledger follows the PRD rules closely enough for the screens to be trusted. */
import {
  balance,
  creditPaise,
  dashboard,
  isStillActive,
  ledgerMonths,
  monthStatus,
  paidAheadPaise,
  suggestPayment,
  tenureMonths,
  type StudentBook,
} from './ledger'

const NOW = '2026-10'

function book(overrides: Partial<StudentBook['student']> = {}, payments: [string, number][] = []) {
  const student = {
    id: 1,
    name: 'Ananya Rao',
    phone: null,
    guardian_name: null,
    batch_label: null,
    joined_month: '2026-07',
    left_month: null,
    notes: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  }
  return {
    student,
    fees: [
      { id: 1, student_id: 1, effective_month: student.joined_month, amount_paise: 150000 },
      { id: 2, student_id: 1, effective_month: '2026-09', amount_paise: 180000 },
    ],
    payments: payments.map(([month, rupees], i) => ({
      id: 10 + i,
      student_id: 1,
      amount_paise: rupees * 100,
      paid_on: `${month}-05`,
      for_month: month,
      method: 'upi' as const,
      note: null,
      created_at: '',
      updated_at: '',
    })),
  } satisfies StudentBook
}

describe('mock ledger', () => {
  it('uses rule 4 for month status', () => {
    expect(monthStatus(150000, 150000)).toBe('paid')
    expect(monthStatus(150000, 50000)).toBe('partial')
    expect(monthStatus(150000, 0)).toBe('unpaid')
    expect(monthStatus(150000, 200000)).toBe('overpaid')
    expect(monthStatus(0, 0)).toBe('not_applicable')
    expect(monthStatus(0, 100)).toBe('overpaid')
  })

  it('keeps old fees for earlier months and marks future months as not due', () => {
    const b = book({}, [
      ['2026-07', 1500],
      ['2026-11', 1800],
    ])
    const months = ledgerMonths(b, NOW)
    expect(months.map((m) => [m.month, m.expected_paise, m.status, m.is_due])).toEqual([
      ['2026-07', 150000, 'paid', true],
      ['2026-08', 150000, 'unpaid', true],
      ['2026-09', 180000, 'unpaid', true],
      ['2026-10', 180000, 'unpaid', true],
      ['2026-11', 180000, 'paid', false],
    ])
    // Paid ahead counts towards the balance (rule 6).
    expect(balance(b, NOW)).toBe(150000 + 180000 - (150000 * 2 + 180000 * 2))
  })

  it('suggests the oldest unpaid month, then the next unpaid one, then nothing', () => {
    expect(suggestPayment(book({}, [['2026-07', 1000]]), NOW)).toMatchObject({
      for_month: '2026-07',
      amount_paise: 50000,
    })
    const upToDate = book({}, [
      ['2026-07', 1500],
      ['2026-08', 1500],
      ['2026-09', 1800],
      ['2026-10', 1800],
    ])
    expect(suggestPayment(upToDate, NOW)).toMatchObject({
      for_month: '2026-11',
      amount_paise: 180000,
    })
    const left = book({ left_month: '2026-10' }, [
      ['2026-07', 1500],
      ['2026-08', 1500],
      ['2026-09', 1800],
      ['2026-10', 1800],
    ])
    expect(suggestPayment(left, NOW)).toEqual({
      for_month: null,
      amount_paise: null,
      reason: 'all_paid',
    })
  })

  it('counts tenure like the backend', () => {
    const b = (joined: string, left: string | null) =>
      book({ joined_month: joined, left_month: left }).student
    expect(tenureMonths(b('2026-09', null), NOW)).toBe(1) // joined last month
    expect(tenureMonths(b('2026-10', null), NOW)).toBe(0) // new this month
    expect(tenureMonths(b('2026-03', '2026-06'), NOW)).toBe(4) // left: both ends counted
    expect(tenureMonths(b('2026-05', '2026-05'), NOW)).toBe(1)
    expect(tenureMonths(b('2026-03', '2026-10'), NOW)).toBe(7) // leaving after now: elapsed
  })

  it('counts a payment for a month after leaving as credit, not paid ahead', () => {
    const b = book({ joined_month: '2026-07', left_month: '2026-08' }, [
      ['2026-07', 1500],
      ['2026-12', 1500],
    ])
    expect(paidAheadPaise(b, NOW)).toBe(0)
    expect(creditPaise(b, NOW)).toBe(150000)
  })

  it('is active until the left month has passed (rule 8)', () => {
    expect(isStillActive(book({ left_month: '2026-10' }).student, NOW)).toBe(true)
    expect(isStillActive(book({ left_month: '2026-09' }).student, NOW)).toBe(false)
  })

  it('builds the dashboard sections', () => {
    const kabir = book({ id: 2, name: 'Kabir Mehta' }, [
      ['2026-07', 2000], // ₹500 extra
      ['2026-09', 1000], // partial
    ])
    const d = dashboard([kabir], NOW, NOW)
    expect(d.summary).toEqual({
      expected_paise: 180000,
      collected_paise: 0,
      still_due_paise: 180000,
      not_fully_paid_count: 1,
      active_student_count: 1,
    })
    expect(d.yet_to_pay[0]).toMatchObject({ status: 'unpaid', remaining_paise: 180000 })
    expect(d.backlog[0]!.months.map((m) => [m.month, m.status])).toEqual([
      ['2026-08', 'unpaid'],
      ['2026-09', 'partial'],
    ])
    expect(d.backlog[0]!.total_owed_paise).toBe(150000 + 80000)
    expect(d.overpaid).toEqual([expect.objectContaining({ month: '2026-07', excess_paise: 50000 })])
    expect(creditPaise(kabir, NOW)).toBe(50000)
  })
})

describe('paid ahead and credit for later months', () => {
  it('counts paid ahead up to the fee, and the rest as credit', () => {
    const b = book({}, [['2026-11', 2000]]) // ₹1,800 fee in November
    expect(paidAheadPaise(b, NOW)).toBe(180000)
    expect(creditPaise(b, NOW)).toBe(20000)
  })

  it('counts a payment for a later month with no fee (a month away) as credit', () => {
    const b = book({}, [['2026-12', 1800]])
    b.fees.push({ id: 3, student_id: 1, effective_month: '2026-12', amount_paise: 0 })
    expect(paidAheadPaise(b, NOW)).toBe(0)
    expect(creditPaise(b, NOW)).toBe(180000)
  })
})
