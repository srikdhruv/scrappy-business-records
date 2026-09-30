/** Status words and colours, shared by every screen (see components/status.tsx). */
import type { BalanceStatus, StudentRead } from '@/api/types'
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

export type Standing = Pick<StudentRead, 'status' | 'owed_paise' | 'credit_paise'>

/**
 * The headline for a student (PRD ledger rule 6): "Owes ₹2,000" whenever any due month is
 * still owed, however much was paid ahead or extra elsewhere; else "Credit ₹500" for money paid
 * too much; else "Up to date". Paying ahead is shown separately, never as credit.
 */
export function standingLabel(s: Standing): string {
  if (s.status === 'owes') return `Owes ${formatRupees(s.owed_paise)}`
  if (s.status === 'credit') return `Credit ${formatRupees(s.credit_paise)}`
  return 'Up to date'
}
