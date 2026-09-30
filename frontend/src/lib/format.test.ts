import {
  addMonths,
  currentMonth,
  formatDate,
  formatMonth,
  formatMonthShort,
  formatRupees,
  formatTenure,
  monthsBetween,
  paiseToRupeesInput,
  rupeesToPaise,
  today,
} from './format'

describe('formatRupees', () => {
  it.each([
    [0, '₹0'],
    [100, '₹1'],
    [50, '₹0.50'],
    [150000, '₹1,500'],
    [15000000, '₹1,50,000'],
    [150050, '₹1,500.50'],
    [150005, '₹1,500.05'],
    [123456789, '₹12,34,567.89'],
    [10000000000, '₹10,00,00,000'],
    [-50000, '-₹500'],
  ])('%i paise -> %s', (paise, expected) => {
    expect(formatRupees(paise)).toBe(expected)
  })
})

describe('rupeesToPaise', () => {
  it.each([
    ['1500', 150000],
    ['1,500', 150000],
    ['1,50,000', 15000000],
    ['1500.50', 150050],
    ['1500.5', 150050],
    ['1500.', 150000],
    ['₹ 1,500', 150000],
    ['Rs. 200', 20000],
    ['  750  ', 75000],
    ['0', 0],
    ['0.05', 5],
  ])('%s -> %i', (input, expected) => {
    expect(rupeesToPaise(input)).toBe(expected)
  })

  it.each(['', ' ', 'abc', '-100', '1.234', '1.2.3', '12a', '.5'])('rejects %j', (input) => {
    expect(rupeesToPaise(input)).toBeNull()
  })

  it('round-trips with paiseToRupeesInput', () => {
    for (const paise of [0, 5, 150000, 150050, 99999999]) {
      expect(rupeesToPaise(paiseToRupeesInput(paise))).toBe(paise)
    }
  })
})

describe('dates and months', () => {
  it('formats dates', () => {
    expect(formatDate('2026-10-05')).toBe('5 Oct 2026')
    expect(formatDate('2026-01-31')).toBe('31 Jan 2026')
  })

  it('formats months', () => {
    expect(formatMonth('2026-10')).toBe('October 2026')
    expect(formatMonth('2027-01')).toBe('January 2027')
    expect(formatMonthShort('2026-10')).toBe('Oct 2026')
    expect(() => formatMonth('2026-13')).toThrow()
  })

  it('uses the local clock for now', () => {
    const now = new Date(2026, 9, 5, 23, 59) // 5 Oct 2026, local time
    expect(currentMonth(now)).toBe('2026-10')
    expect(today(now)).toBe('2026-10-05')
  })

  it('adds months across years', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2025-12', 1)).toBe('2026-01')
    expect(addMonths('2026-10', 15)).toBe('2028-01')
    expect(addMonths('2026-10', -22)).toBe('2024-12')
    expect(addMonths('2026-10', 0)).toBe('2026-10')
  })

  it('counts months between', () => {
    expect(monthsBetween('2025-07', '2026-10')).toBe(15)
    expect(monthsBetween('2026-10', '2026-07')).toBe(-3)
  })
})

describe('formatTenure', () => {
  it.each([
    ['2025-07', '2026-10', '1 yr 3 mo'],
    ['2026-06', '2026-10', '4 mo'],
    ['2026-10', '2026-10', 'New this month'],
    ['2025-10', '2026-10', '1 yr'],
    ['2023-09', '2026-10', '3 yrs 1 mo'],
    ['2026-11', '2026-10', 'Starts November 2026'],
  ])('joined %s, now %s -> %s', (joined, now, expected) => {
    expect(formatTenure(joined, now)).toBe(expected)
  })

  it('accepts a Date', () => {
    expect(formatTenure('2026-06', new Date(2026, 9, 1))).toBe('4 mo')
  })
})
