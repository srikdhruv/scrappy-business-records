import type { CreditMoveItem } from '@/api/types'

import {
  checkText,
  creditSourceText,
  extraSentText,
  groupMoves,
  monthNotes,
  monthRanges,
  paymentUseText,
  previewText,
} from './credit'

const own = { own_month: '2026-09', own_expected_paise: 150000, own_paise: 150000 }

describe('the words for extra money', () => {
  it('names where a month’s credit came from, and where extra went', () => {
    expect(
      creditSourceText({
        payment_id: 3,
        paid_on: '2026-09-05',
        for_month: '2026-09',
        amount_paise: 150000,
      }),
    ).toBe('₹1,500 credit from the 5 Sep 2026 payment (for Sep 2026)')
    expect(extraSentText({ to_month: '2026-08', amount_paise: 150000 })).toBe(
      '₹1,500 extra → Aug 2026',
    )
  })

  it('collapses months in a row into a range', () => {
    expect(monthRanges(['2026-08'])).toBe('Aug 2026')
    expect(monthRanges(['2026-11', '2026-10', '2026-12'])).toBe('Oct 2026 to Dec 2026')
    expect(monthRanges(['2026-06', '2026-08', '2026-09'])).toBe('Jun 2026 and Aug 2026 to Sep 2026')
  })

  it('merges a month’s notes: same-day payments together, runs of months as one', () => {
    const notes = monthNotes({
      month: '2026-08',
      credit_sources: [
        { payment_id: 3, paid_on: '2026-09-05', for_month: '2026-09', amount_paise: 50000 },
        { payment_id: 4, paid_on: '2026-09-05', for_month: '2026-09', amount_paise: 100000 },
      ],
      extra_sent: [],
    })
    expect(notes).toEqual([
      { key: 'from-3-4-2026-08', text: '₹1,500 credit from the 5 Sep 2026 payment (for Sep 2026)' },
    ])
    const sent = monthNotes({
      month: '2026-09',
      credit_sources: [],
      extra_sent: Array.from({ length: 24 }, (_, i) => ({
        to_month: `${2026 + Math.floor((9 + i) / 12)}-${String(((9 + i) % 12) + 1).padStart(2, '0')}`,
        amount_paise: 150000,
      })),
    })
    expect(sent.map((n) => n.text)).toEqual(['₹36,000 extra → Oct 2026 to Sep 2028'])
  })

  it('says where a payment’s money went', () => {
    expect(paymentUseText({ extra_sent: [], extra_unused_paise: 0 })).toBeNull()
    expect(
      paymentUseText({
        extra_sent: [{ to_month: '2026-08', amount_paise: 150000 }],
        extra_unused_paise: 0,
      }),
    ).toBe('₹1,500 went to Aug 2026')
    expect(
      paymentUseText({
        extra_sent: [
          { to_month: '2026-07', amount_paise: 150000 },
          { to_month: '2026-08', amount_paise: 50000 },
        ],
        extra_unused_paise: 20000,
      }),
    ).toBe('₹2,000 went to Jul 2026 to Aug 2026; ₹200 kept as credit')
  })

  it('flags a payment that may be a typo, always with the reason', () => {
    expect(
      checkText({ amount_paise: 1500000, paysUntil: '2027-06', monthsAhead: 9, unused_paise: 0 }),
    ).toBe('Check: this ₹15,000 payment pays up to Jun 2027 — 9 months ahead')
    expect(
      checkText({
        amount_paise: 250000,
        paysUntil: '2026-07',
        monthsAhead: 0,
        unused_paise: 50000,
      }),
    ).toBe('Check: this ₹2,500 payment — ₹500 isn’t needed by any month')
    expect(
      checkText({
        amount_paise: 6000000,
        paysUntil: '2028-09',
        monthsAhead: 24,
        unused_paise: 1500000,
      }),
    ).toBe(
      'Check: this ₹60,000 payment pays up to Sep 2028 — 24 months ahead; ₹15,000 isn’t needed by any month',
    )
  })

  it('groups the dashboard’s moves by payment', () => {
    const move = (to: string, id = 7): CreditMoveItem => ({
      student_id: 1,
      student_name: 'Ananya Rao',
      batch_label: null,
      batch_name: null,
      phone: null,
      payment_id: id,
      paid_on: '2026-09-20',
      from_month: '2026-09',
      to_month: to,
      amount_paise: 150000,
      payment_amount_paise: id === 7 ? 4500000 : 300000,
      payment_pays_until: id === 7 ? '2028-09' : '2026-10',
      payment_needs_check: id === 7,
      payment_months_ahead: id === 7 ? 24 : 1,
      payment_extra_unused_paise: 0,
    })
    const groups = groupMoves([move('2026-10'), move('2026-11'), move('2026-10', 8)])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      to_months: ['2026-10', '2026-11'],
      amount_paise: 450000,
      payment_ids: [7, 8],
      payment_amount_paise: 4800000,
      pays_until: '2028-09',
      months_ahead: 24,
      needs_check: true,
    })
  })

  it('previews a payment by what its own money does', () => {
    expect(previewText({ ...own, covers: [], credit_paise: 0 })).toBeNull()
    expect(
      previewText({
        ...own,
        covers: [{ month: '2026-08', amount_paise: 150000, was: 'unpaid', full: true }],
        credit_paise: 0,
      }),
    ).toBe('₹1,500 more than the September fee: it will pay August 2026 (unpaid).')
    expect(
      previewText({
        ...own,
        covers: [
          { month: '2026-10', amount_paise: 150000, was: 'ahead', full: true },
          { month: '2026-11', amount_paise: 50000, was: 'ahead', full: false },
        ],
        credit_paise: 0,
      }),
    ).toBe(
      '₹2,000 more than the September fee: it will pay October 2026 and part of November 2026 ahead.',
    )
    const ahead = ['2026-10', '2026-11', '2026-12'].map((month, i) => ({
      month,
      amount_paise: 150000,
      was: 'ahead' as const,
      full: i < 2,
    }))
    expect(previewText({ ...own, covers: ahead, credit_paise: 30000 })).toBe(
      '₹4,800 more than the September fee: it will pay 3 months ahead (October 2026 to December ' +
        '2026, the last in part), and ₹300 will be kept as credit (nothing else is owed).',
    )
    expect(previewText({ ...own, own_paise: 50000, covers: [], credit_paise: 30000 })).toBe(
      '₹300 more than what’s left of the September fee: nothing else is owed, so it will be kept as credit.',
    )
    expect(
      previewText({
        ...own,
        own_expected_paise: 0,
        own_paise: 0,
        covers: [{ month: '2026-05', amount_paise: 150000, was: 'unpaid', full: true }],
        credit_paise: 0,
      }),
    ).toBe('No fee is due for September, so all ₹1,500 is extra: it will pay May 2026 (unpaid).')
  })
})
