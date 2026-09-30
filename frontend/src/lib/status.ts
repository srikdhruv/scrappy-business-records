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

/** "Up to date" / "Owes ₹3,000" / "Credit ₹500". */
export function balanceLabel(status: BalanceStatus, balancePaise: number): string {
  if (status === 'owes') return `Owes ${formatRupees(Math.abs(balancePaise))}`
  if (status === 'credit') return `Credit ${formatRupees(balancePaise)}`
  return 'Up to date'
}
