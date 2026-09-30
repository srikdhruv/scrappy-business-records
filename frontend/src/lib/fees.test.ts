import { afterReturn, feeAt, feeWords, newFeeSentence, nextFeeChange, returnFee } from './fees'

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
    // A ₹0 fee with nothing after it never ends: said plainly.
    expect(newFeeSentence(history, '2027-01', 0, NOW)).toBe(
      'They’ll have no fee from January 2027 onwards, with no end.',
    )
    expect(newFeeSentence(history, '2026-10', 0, NOW)).toBe(
      'From October 2026 they’ll have no fee, until December 2026, when no fee (already scheduled) starts.',
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

describe('returnFee and afterReturn', () => {
  const row = (
    id: number,
    effective_month: string,
    amount_paise: number,
    kind: 'fee' | 'away',
  ) => ({
    id,
    effective_month,
    amount_paise,
    kind,
  })
  const fees = [
    row(1, '2026-01', 200000, 'fee'),
    row(2, '2026-04', 0, 'away'), // an earlier return's months away
    row(3, '2026-07', 200000, 'fee'),
    row(4, '2026-11', 0, 'fee'), // a month off the owner set
    row(5, '2026-12', 200000, 'fee'),
  ]

  it('never comes back on an "away" row, but does on an owner\'s ₹0', () => {
    expect(returnFee(fees, '2026-04')).toBe(200000)
    expect(returnFee(fees, '2026-05')).toBe(200000)
    expect(returnFee(fees, '2026-11')).toBe(0)
  })

  it('shows the history as it will be: old "away" rows gone, the owner\'s month off kept', () => {
    const after = afterReturn(fees, '2026-03', '2026-08', 200000)
    expect(after.map((f) => [f.effective_month, f.amount_paise, f.kind])).toEqual([
      ['2026-01', 200000, 'fee'],
      ['2026-04', 0, 'away'],
      ['2026-08', 200000, 'fee'],
      ['2026-11', 0, 'fee'],
      ['2026-12', 200000, 'fee'],
    ])
    // Back straight after leaving: no gap, and the earlier return's "away" April is gone.
    expect(afterReturn(fees, '2026-03', '2026-04', 200000).map((f) => f.kind)).toEqual([
      'fee',
      'fee',
      'fee',
      'fee',
      'fee',
    ])
  })
})

describe('feeWords', () => {
  it('names a 0 fee as "no fee"', () => {
    expect(feeWords(0)).toBe('no fee')
    expect(feeWords(150000)).toBe('₹1,500 a month')
  })
})
