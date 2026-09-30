/**
 * Money, date and month formatting. Format money and dates ONLY through this module.
 *
 * Conventions (docs/data-model.md):
 * - Money is integer paise in the API. ₹1,500 = 150000.
 * - Months are "YYYY-MM". Dates are "YYYY-MM-DD". Both are parsed by hand (never `new Date(str)`)
 *   so time zones can't shift them by a day.
 * - "Now" comes from the laptop's local clock.
 */

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/
const DATE_RE = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

/** Group digits the Indian way: 1234567 -> "12,34,567". */
function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits
  const last3 = digits.slice(-3)
  const rest = digits.slice(0, -3)
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`
}

/**
 * 15000000 -> "₹1,50,000"; 150050 -> "₹1,500.50"; -50000 -> "-₹500".
 * Whole rupees show no decimals; otherwise exactly two.
 */
export function formatRupees(paise: number): string {
  if (!Number.isFinite(paise)) return '—'
  const whole = Math.round(paise)
  const sign = whole < 0 ? '-' : ''
  const abs = Math.abs(whole)
  const rupees = Math.floor(abs / 100)
  const rem = abs % 100
  const fraction = rem === 0 ? '' : `.${String(rem).padStart(2, '0')}`
  return `${sign}₹${groupIndian(String(rupees))}${fraction}`
}

/**
 * ₹10,00,000: the most a single payment or monthly fee can be. A typo guard (an extra zero or
 * two), not a business rule. Must match `MAX_AMOUNT_PAISE` in backend/app/schemas.py, which
 * rejects anything larger with a 422.
 */
export const MAX_AMOUNT_PAISE = 100_000_000

// The whole-rupee part: plain digits, or correctly grouped with commas the Indian way
// (1,50,000) or the Western way (150,000). Mis-grouped input like "15,00" is rejected, and so is
// a comma group starting with 0 ("0,500").
const RUPEES_PLAIN = /^\d+$/
const RUPEES_INDIAN = /^[1-9]\d?(?:,\d{2})*,\d{3}$/
const RUPEES_WESTERN = /^[1-9]\d{0,2}(?:,\d{3})+$/

/**
 * Parse what a person types into an amount box into paise.
 *
 * Accepts "1500", "1,500", "1,50,000", "150,000", "1500.5", "1500.50", ".5", "₹ 1,500",
 * "Rs. 200" and the Indian "/-" suffix ("₹1,500/-"). Spaces are allowed only at the ends and
 * after the ₹ / Rs / INR prefix.
 *
 * Returns null for anything else: empty, negative, letters, spaces inside the number
 * ("1500 50"), more than 2 decimals, commas in the wrong places ("15,00", "1,5,0", "0,500"),
 * more than `MAX_AMOUNT_PAISE`, and 0 unless `allowZero` is set (e.g. for a fee).
 */
export function rupeesToPaise(
  input: string,
  { allowZero = false }: { allowZero?: boolean } = {},
): number | null {
  const cleaned = input
    .trim()
    .replace(/^(?:₹|rs\.?|inr)\s*/i, '')
    .replace(/\s*\/-$/, '')
  const match = /^([\d,]*)(?:\.(\d{0,2}))?$/.exec(cleaned)
  if (!match) return null
  const whole = match[1] ?? ''
  const decimals = match[2]
  if (whole === '' && !decimals) return null // "", "." — no digits at all
  if (
    whole !== '' &&
    !RUPEES_PLAIN.test(whole) &&
    !RUPEES_INDIAN.test(whole) &&
    !RUPEES_WESTERN.test(whole)
  ) {
    return null
  }
  const rupees = Number(whole.replace(/,/g, '') || '0')
  const paise = rupees * 100 + Number((decimals ?? '').padEnd(2, '0'))
  if (!Number.isSafeInteger(paise) || paise > MAX_AMOUNT_PAISE) return null
  if (paise === 0 && !allowZero) return null
  return paise
}

/** Paise -> the plain number to prefill an amount box with: 150000 -> "1500", 150050 -> "1500.50". */
export function paiseToRupeesInput(paise: number): string {
  const whole = Math.round(paise)
  const sign = whole < 0 ? '-' : ''
  const abs = Math.abs(whole)
  const rupees = Math.floor(abs / 100)
  const rem = abs % 100
  return `${sign}${rupees}${rem === 0 ? '' : `.${String(rem).padStart(2, '0')}`}`
}

function parseMonth(month: string): { year: number; month: number } {
  const m = MONTH_RE.exec(month)
  if (!m) throw new Error(`Expected a month like 2026-10, got "${month}"`)
  return { year: Number(m[1]), month: Number(m[2]) }
}

function toMonth(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
}

function monthIndex(month: string): number {
  const { year, month: m } = parseMonth(month)
  return year * 12 + (m - 1)
}

/** "2026-10-05" -> "5 Oct 2026". */
export function formatDate(date: string): string {
  const m = DATE_RE.exec(date)
  if (!m) return date
  const name = MONTH_NAMES[Number(m[2]) - 1]!.slice(0, 3)
  return `${Number(m[3])} ${name} ${m[1]}`
}

/** "2026-10" -> "October 2026". */
export function formatMonth(month: string): string {
  const { year, month: m } = parseMonth(month)
  return `${MONTH_NAMES[m - 1]} ${year}`
}

/** "2026-10" -> "Oct 2026", for tight spaces such as table cells. */
export function formatMonthShort(month: string): string {
  const { year, month: m } = parseMonth(month)
  return `${MONTH_NAMES[m - 1]!.slice(0, 3)} ${year}`
}

/** The current month on the laptop's clock, as "YYYY-MM". */
export function currentMonth(now: Date = new Date()): string {
  return toMonth(now.getFullYear(), now.getMonth() + 1)
}

/** Today's date on the laptop's clock, as "YYYY-MM-DD". */
export function today(now: Date = new Date()): string {
  return `${currentMonth(now)}-${String(now.getDate()).padStart(2, '0')}`
}

/** addMonths("2026-01", -1) -> "2025-12". */
export function addMonths(month: string, n: number): string {
  const index = monthIndex(month) + n
  return toMonth(Math.floor(index / 12), (index % 12) + 1)
}

/** Whole months from `from` to `to` (negative if `to` is earlier). */
export function monthsBetween(from: string, to: string): number {
  return monthIndex(to) - monthIndex(from)
}

/**
 * How long someone has been a student, counted in calendar months from the month they joined.
 * formatTenure("2025-07", "2026-10") -> "1 yr 3 mo"; "2026-06" -> "4 mo"; same month ->
 * "New this month". `now` may be a Date or a "YYYY-MM" month (defaults to today).
 */
export function formatTenure(joinedMonth: string, now: Date | string = new Date()): string {
  const nowMonth = typeof now === 'string' ? now : currentMonth(now)
  const months = monthsBetween(joinedMonth, nowMonth)
  if (months < 0) return `Starts ${formatMonth(joinedMonth)}`
  if (months === 0) return 'New this month'
  const years = Math.floor(months / 12)
  const rest = months % 12
  const parts: string[] = []
  if (years > 0) parts.push(`${years} ${years === 1 ? 'yr' : 'yrs'}`)
  if (rest > 0) parts.push(`${rest} mo`)
  return parts.join(' ')
}
