/** Status words and colours, shared by every screen (see components/status.tsx). */
import type { BalanceStatus } from '@/api/types'
import { formatRupees } from '@/lib/format'

export type Tone = 'paid' | 'partial' | 'owed' | 'credit' | 'muted'

export const TONE_TEXT: Record<Tone, string> = {
  paid: 'text-paid',
  partial: 'text-partial',
  owed: 'text-owed',
  credit: 'text-credit',
  muted: 'text-muted-foreground',
}

export function balanceTone(status: BalanceStatus): Tone {
  return status === 'owes' ? 'owed' : status === 'credit' ? 'credit' : 'paid'
}

/**
 * "Up to date" / "Owes ₹3,000" / "Credit ₹500" / "Paid ahead ₹2,000".
 *
 * A positive balance is either money paid too much for a month that's due (`creditPaise`, real
 * credit) or simply paying ahead for months not due yet. Only the first is called credit.
 */
export function balanceLabel(
  status: BalanceStatus,
  balancePaise: number,
  creditPaise: number,
): string {
  if (status === 'owes') return `Owes ${formatRupees(Math.abs(balancePaise))}`
  if (status === 'credit') {
    return creditPaise > 0
      ? `Credit ${formatRupees(balancePaise)}`
      : `Paid ahead ${formatRupees(balancePaise)}`
  }
  return 'Up to date'
}
