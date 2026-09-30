import type { PaymentMethod, StudentRead } from '@/api/types'
import { formatMonth } from '@/lib/format'

export const METHOD_LABELS: Record<PaymentMethod, string> = {
  upi: 'UPI',
  cash: 'Cash',
  other: 'Other',
}

/** "Ananya Rao" -> "Ananya", for friendlier sentences. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

/** "1 payment" / "3 payments". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`
}

/** 16 -> "1 yr 4 mo"; 12 -> "1 yr"; 3 -> "3 mo". */
export function formatMonthCount(months: number): string {
  const years = Math.floor(months / 12)
  const rest = months % 12
  const parts: string[] = []
  if (years > 0) parts.push(`${years} ${years === 1 ? 'yr' : 'yrs'}`)
  if (rest > 0 || years === 0) parts.push(`${rest} mo`)
  return parts.join(' ')
}

type Tenure = Pick<StudentRead, 'tenure_months' | 'joined_month' | 'current_month'>

/**
 * How long someone has been a student, from the server's `tenure_months` (whole months since
 * joining): "New this month", "1 mo", "1 yr 4 mo", or "Starts November 2026".
 */
export function tenureLabel(s: Tenure): string {
  if (s.joined_month > s.current_month) return `Starts ${formatMonth(s.joined_month)}`
  if (s.tenure_months === 0) return 'New this month'
  return formatMonthCount(s.tenure_months)
}

/** The same, to finish a sentence: "member for 1 yr 4 mo", "new this month", "starts …". */
export function tenurePhrase(s: Tenure): string {
  if (s.joined_month > s.current_month) return `starts ${formatMonth(s.joined_month)}`
  if (s.tenure_months === 0) return 'new this month'
  return `member for ${formatMonthCount(s.tenure_months)}`
}
