import type { PaymentMethod } from '@/api/schema'

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
