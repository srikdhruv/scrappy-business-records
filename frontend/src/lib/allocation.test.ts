/**
 * The browser copy of "extra money covers unpaid months" (PRD ledger rule 10) gives the same
 * answers as the backend's `allocate` (backend/tests/test_allocation.py has the same cases).
 */
import {
  allocate,
  allocationMonths,
  expectedFrom,
  monthShare,
  previewPayment,
  type AllocPayment,
} from './allocation'

const NOW = '2026-09'
const student = { joined_month: '2026-06', left_month: null }
const fees = [{ effective_month: '2026-06', amount_paise: 150000 }]
const expected = expectedFrom(student, fees)

const pay = (id: number, month: string, rupees: number, paidOn = `${month}-05`): AllocPayment => ({
  id,
  for_month: month,
  amount_paise: rupees * 100,
  paid_on: paidOn,
})

describe('allocate', () => {
  it('the real case: September paid double while August was unpaid', () => {
    const payments = [pay(1, '2026-06', 1500), pay(2, '2026-07', 1500), pay(3, '2026-09', 3000)]
    const alloc = allocate(payments, student, expected, NOW)
    expect(monthShare(alloc, '2026-08')).toEqual({
      paid_direct_paise: 0,
      covered_by_credit_paise: 150000,
      credit_sources: [
        { payment_id: 3, paid_on: '2026-09-05', for_month: '2026-09', amount_paise: 150000 },
      ],
      extra_sent: [],
      extra_unused_paise: 0,
    })
    expect(monthShare(alloc, '2026-09')).toMatchObject({
      paid_direct_paise: 150000,
      covered_by_credit_paise: 0,
      extra_sent: [{ to_month: '2026-08', amount_paise: 150000 }],
    })
    expect(alloc.uses[2]).toMatchObject({ paid_direct_paise: 150000, extra_unused_paise: 0 })
  })

  it('hands out extra in the order payments were paid, then entered', () => {
    const early = pay(9, '2026-09', 2000, '2026-08-01')
    const late = pay(1, '2026-08', 2000, '2026-08-20')
    const alloc = allocate([late, early], student, expected, NOW)
    expect(monthShare(alloc, '2026-06').credit_sources.map((s) => s.payment_id)).toEqual([9, 1])
    const sameDay = allocate(
      [pay(7, '2026-09', 2000, '2026-09-03'), pay(4, '2026-09', 700, '2026-09-03')],
      student,
      expected,
      NOW,
    )
    // Payment 4 was entered first, so it pays September first.
    expect(sameDay.uses.map((u) => [u.payment.id, u.paid_direct_paise])).toEqual([
      [7, 80000],
      [4, 70000],
    ])
  })

  it('skips months with no fee, and stops at the left month or two years ahead', () => {
    // Away in July and August, back in September.
    const away = expectedFrom(student, [
      ...fees,
      { effective_month: '2026-07', amount_paise: 0 },
      { effective_month: '2026-09', amount_paise: 150000 },
    ])
    expect(allocationMonths(student, away, NOW).slice(0, 3)).toEqual([
      '2026-06',
      '2026-09',
      '2026-10',
    ])
    expect(allocationMonths(student, expected, NOW).at(-1)).toBe('2028-09')
    const leaving = { joined_month: '2026-06', left_month: '2026-07' }
    const alloc = allocate([pay(1, '2026-06', 6000)], leaving, expectedFrom(leaving, fees), NOW)
    expect(alloc.uses[0]).toMatchObject({
      paid_direct_paise: 150000,
      extra_sent: [{ to_month: '2026-07', amount_paise: 150000 }],
      extra_unused_paise: 300000,
    })
  })
})

describe('previewPayment', () => {
  const others = [pay(1, '2026-06', 1500), pay(2, '2026-07', 1500)]

  it('says what the extra on a new payment will cover', () => {
    const preview = previewPayment({
      others,
      draft: pay(99, '2026-09', 3000, '2026-09-10'),
      student,
      expected,
      now: NOW,
    })
    expect(preview).toEqual({
      own_paise: 150000,
      covers: [{ month: '2026-08', amount_paise: 150000, was: 'unpaid', full: true }],
      credit_paise: 0,
    })
  })

  it('counts paying a month that credit already covered as moving that credit on', () => {
    // September's double payment pays August. A new August payment pays August itself, so the
    // September extra moves on to October: the net effect is October paid ahead.
    const withDouble = [...others, pay(3, '2026-09', 3000)]
    const preview = previewPayment({
      others: withDouble,
      draft: pay(99, '2026-08', 1500, '2026-09-10'),
      student,
      expected,
      now: NOW,
    })
    expect(preview.own_paise).toBe(0)
    expect(preview.covers).toEqual([
      { month: '2026-10', amount_paise: 150000, was: 'ahead', full: true },
    ])
  })

  it('says when money is left over as credit', () => {
    const leaving = { joined_month: '2026-06', left_month: '2026-07' }
    const preview = previewPayment({
      others,
      draft: pay(99, '2026-07', 2000, '2026-09-10'),
      student: leaving,
      expected: expectedFrom(leaving, fees),
      now: NOW,
    })
    expect(preview).toEqual({ own_paise: 0, covers: [], credit_paise: 200000 })
  })
})
