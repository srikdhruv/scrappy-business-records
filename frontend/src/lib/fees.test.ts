import { feeAt, feeWords, newFeeSentence, nextFeeChange } from './fees'

const history = [
  { id: 1, effective_month: '2025-10', amount_paise: 150000 },
  { id: 2, effective_month: '2026-04', amount_paise: 180000 },
  { id: 3, effective_month: '2026-12', amount_paise: 0 },
]
const NOW = '2026-09'

describe('feeAt', () => {
  it('reads the latest fee change on or before the month', () => {
    expect(feeAt(history, '2025-09')).toBe(0)
    expect(feeAt(history, '2025-10')).toBe(150000)
    expect(feeAt(history, '2026-03')).toBe(150000)
    expect(feeAt(history, '2026-09')).toBe(180000)
    expect(feeAt(history, '2027-01')).toBe(0)
    expect(feeAt(history.toReversed(), '2026-05')).toBe(180000)
  })
})

describe('nextFeeChange', () => {
  it('finds the first change after a month', () => {
    expect(nextFeeChange(history, '2026-02')?.id).toBe(2)
    expect(nextFeeChange(history, '2026-04')?.id).toBe(3)
    expect(nextFeeChange(history, '2026-12')).toBeUndefined()
  })
})

describe('newFeeSentence', () => {
  it('says until when a new fee lasts, from the real schedule', () => {
    expect(newFeeSentence(history, '2026-02', 210000, NOW)).toBe(
      'From February 2026 they’ll owe ₹2,100 a month, until April 2026, when ₹1,800 (already set) starts.',
    )
    expect(newFeeSentence(history, '2026-10', 210000, NOW)).toBe(
      'From October 2026 they’ll owe ₹2,100 a month, until December 2026, when no fee (already scheduled) starts.',
    )
    expect(newFeeSentence(history, '2027-01', 210000, NOW)).toBe(
      'From January 2027 they’ll owe ₹2,100 a month.',
    )
    expect(newFeeSentence(history, '2027-01', 0, NOW)).toBe(
      'From January 2027 they’ll have no fee.',
    )
  })

  it('says "already scheduled" only for a change still to come', () => {
    const one = [
      { effective_month: '2026-01', amount_paise: 150000 },
      { effective_month: '2026-11', amount_paise: 180000 },
    ]
    expect(newFeeSentence(one, '2026-09', 210000, NOW)).toContain(
      'until November 2026, when ₹1,800 (already scheduled) starts.',
    )
  })
})

describe('feeWords', () => {
  it('names a 0 fee as "no fee"', () => {
    expect(feeWords(0)).toBe('no fee')
    expect(feeWords(150000)).toBe('₹1,500 a month')
  })
})
