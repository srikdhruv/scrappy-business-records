import {
  addMonths,
  currentMonth,
  formatDate,
  formatDateTime,
  formatMonth,
  formatMonthShort,
  formatMonthSpan,
  formatRupees,
  MAX_AMOUNT_PAISE,
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
    ['0.05', 5],
    ['.5', 50],
    ['.05', 5],
    ['150,000', 15000000],
    ['123,456', 12345600],
    ['1,23,456', 12345600],
    ['9,99,999.99', 99999999],
    ['₹1,500', 150000],
    ['₹1,500/-', 150000],
    ['1500/-', 150000],
    ['Rs. 1,500 /-', 150000],
    ['INR 2,000', 200000],
    ['₹  1,500  ', 150000],
    ['0500', 50000],
  ])('%s -> %i', (input, expected) => {
    expect(rupeesToPaise(input)).toBe(expected)
  })

  it.each([
    '',
    ' ',
    '.',
    'abc',
    '-100',
    '1.234',
    '1.2.3',
    '12a',
    '15,00',
    '1,5,0',
    ',500',
    '1500,',
    '1,,500',
    '12,3456',
    '1,500,00',
    // spaces inside the number
    '1500 50',
    '15 00',
    '1, 500',
    '1500 .50',
    '₹1 500',
    // a comma group can't start with 0
    '0,500',
    '00,500',
    '0,50,000',
    // "/-" only as a suffix
    '/-',
    '1500/-/-',
    '15/-00',
  ])('rejects %j', (input) => {
    expect(rupeesToPaise(input)).toBeNull()
  })

  it('caps amounts at ₹10,00,000', () => {
    expect(MAX_AMOUNT_PAISE).toBe(100_000_000) // same as backend MAX_AMOUNT_PAISE
    expect(rupeesToPaise('10,00,000')).toBe(MAX_AMOUNT_PAISE)
    expect(rupeesToPaise('1,000,000')).toBe(MAX_AMOUNT_PAISE)
    expect(rupeesToPaise('10,00,000.01')).toBeNull()
    expect(rupeesToPaise('10,00,001')).toBeNull()
    expect(rupeesToPaise('1,00,00,000')).toBeNull()
    expect(rupeesToPaise('99999999999999999999')).toBeNull()
  })

  it('rejects zero unless allowed', () => {
    expect(rupeesToPaise('0')).toBeNull()
    expect(rupeesToPaise('0.00')).toBeNull()
    expect(rupeesToPaise('0', { allowZero: true })).toBe(0)
    expect(rupeesToPaise('0.00', { allowZero: true })).toBe(0)
  })

  it('round-trips with paiseToRupeesInput', () => {
    for (const paise of [5, 50, 150000, 150050, 99999999]) {
      expect(rupeesToPaise(paiseToRupeesInput(paise))).toBe(paise)
    }
    expect(rupeesToPaise(paiseToRupeesInput(0), { allowZero: true })).toBe(0)
  })
})

describe('paiseToRupeesInput', () => {
  it.each([
    [0, '0'],
    [50, '0.50'],
    [150000, '1500'],
    [150050, '1500.50'],
    [-150, '-1.50'],
    [-50, '-0.50'],
    [-150000, '-1500'],
  ])('%i -> %s', (paise, expected) => {
    expect(paiseToRupeesInput(paise)).toBe(expected)
  })
})

describe('dates and months', () => {
  it('formats dates', () => {
    expect(formatDate('2026-10-05')).toBe('5 Oct 2026')
    expect(formatDate('2026-01-31')).toBe('31 Jan 2026')
  })

  it('formats a moment in local time', () => {
    const local = new Date(2026, 8, 30, 9, 5) // 30 Sep 2026, 09:05 on this machine
    expect(formatDateTime(local.toISOString())).toBe('30 Sep 2026, 09:05')
    expect(formatDateTime('not a date')).toBe('not a date')
  })

  it('formats months', () => {
    expect(formatMonth('2026-10')).toBe('October 2026')
    expect(formatMonth('2027-01')).toBe('January 2027')
    expect(formatMonthShort('2026-10')).toBe('Oct 2026')
    expect(() => formatMonth('2026-13')).toThrow()
  })

  it('formats a run of months', () => {
    expect(formatMonthSpan('2026-06', '2026-06')).toBe('June 2026')
    expect(formatMonthSpan('2026-06', '2026-08')).toBe('June–August 2026')
    expect(formatMonthSpan('2025-12', '2026-02')).toBe('December 2025 – February 2026')
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
