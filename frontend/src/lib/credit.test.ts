import { creditSourceText, extraSentText, paymentUseText, previewText } from './credit'

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
    ).toBe('₹1,500 went to Jul 2026 and ₹500 to Aug 2026; ₹200 kept as credit')
  })

  it('previews what a payment’s extra will cover', () => {
    expect(previewText({ own_paise: 150000, covers: [], credit_paise: 0 })).toBeNull()
    expect(
      previewText({
        own_paise: 150000,
        covers: [{ month: '2026-08', amount_paise: 150000, was: 'unpaid', full: true }],
        credit_paise: 0,
      }),
    ).toBe('₹1,500 extra will cover August 2026 (unpaid).')
    expect(
      previewText({
        own_paise: 150000,
        covers: [
          { month: '2026-07', amount_paise: 50000, was: 'part_paid', full: true },
          { month: '2026-10', amount_paise: 70000, was: 'ahead', full: false },
        ],
        credit_paise: 0,
      }),
    ).toBe('₹1,200 extra will cover July 2026 (part paid) and part of October 2026 (paid ahead).')
    const ahead = ['2026-10', '2026-11', '2026-12'].map((month, i) => ({
      month,
      amount_paise: 150000,
      was: 'ahead' as const,
      full: i < 2,
    }))
    expect(previewText({ own_paise: 0, covers: ahead, credit_paise: 30000 })).toBe(
      '₹4,500 extra will cover 3 months ahead (October 2026 to December 2026, the last in part). ' +
        '₹300 more will be kept as credit: nothing else is owed.',
    )
    expect(previewText({ own_paise: 0, covers: [], credit_paise: 30000 })).toBe(
      '₹300 extra will be kept as credit: nothing else is owed.',
    )
  })
})
