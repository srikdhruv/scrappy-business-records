/**
 * The words for extra money that covers other months (PRD ledger rule 10), shared by every
 * screen, so the same thing is always said the same way.
 */
import type { CreditSource, ExtraSent } from '@/api/types'
import type { PaymentPreview } from '@/lib/allocation'
import { formatDate, formatMonth, formatMonthShort, formatRupees } from '@/lib/format'

/** "₹1,500 credit from the 5 Sep 2026 payment (for Sep 2026)": on the month it pays. */
export function creditSourceText(source: CreditSource): string {
  return `${formatRupees(source.amount_paise)} credit from the ${formatDate(source.paid_on)} payment (for ${formatMonthShort(source.for_month)})`
}

/** "₹1,500 extra → Aug 2026": on the month whose payment had it. */
export function extraSentText(sent: ExtraSent): string {
  return `${formatRupees(sent.amount_paise)} extra → ${formatMonthShort(sent.to_month)}`
}

/** "a", "a and b", "a, b and c". */
function listed(phrases: string[]): string {
  return phrases.length <= 1
    ? phrases.join('')
    : `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`
}

/**
 * "₹1,500 went to Aug 2026", "₹1,500 went to Jul 2026 and ₹500 to Aug 2026", and "₹500 kept as
 * credit": on a payment. Null when all of it paid its own month.
 */
export function paymentUseText(p: {
  extra_sent: ExtraSent[]
  extra_unused_paise: number
}): string | null {
  const moved = listed(
    p.extra_sent.map(
      (e, i) =>
        `${formatRupees(e.amount_paise)}${i === 0 ? ' went' : ''} to ${formatMonthShort(e.to_month)}`,
    ),
  )
  const kept =
    p.extra_unused_paise > 0 ? `${formatRupees(p.extra_unused_paise)} kept as credit` : ''
  return [moved, kept].filter(Boolean).join('; ') || null
}

const WAS: Record<PaymentPreview['covers'][number]['was'], string> = {
  unpaid: 'unpaid',
  part_paid: 'part paid',
  ahead: 'paid ahead',
}

/** "July 2026 (unpaid)", "part of October 2026 (paid ahead)", or a run of months in short. */
function coverPhrases(covers: PaymentPreview['covers']): string[] {
  const one = (c: PaymentPreview['covers'][number]) =>
    `${c.full ? '' : 'part of '}${formatMonth(c.month)} (${WAS[c.was]})`
  const due = covers.filter((c) => c.was !== 'ahead')
  const ahead = covers.filter((c) => c.was === 'ahead')
  const phrases =
    due.length <= 3
      ? due.map(one)
      : [
          `${due.length} months still owed (${formatMonth(due[0]!.month)} to ${formatMonth(due.at(-1)!.month)})`,
        ]
  if (ahead.length === 1) phrases.push(one(ahead[0]!))
  if (ahead.length > 1) {
    const last = ahead.at(-1)!
    phrases.push(
      `${ahead.length} months ahead (${formatMonth(ahead[0]!.month)} to ${formatMonth(last.month)}${last.full ? '' : ', the last in part'})`,
    )
  }
  return phrases
}

/**
 * What saving a payment would do with the money above its own month's fee, e.g. "₹1,500 extra
 * will cover August 2026 (unpaid)." Null when there is no extra.
 */
export function previewText(preview: PaymentPreview): string | null {
  const extra = preview.covers.reduce((sum, c) => sum + c.amount_paise, 0)
  const sentences: string[] = []
  if (extra > 0) {
    sentences.push(
      `${formatRupees(extra)} extra will cover ${listed(coverPhrases(preview.covers))}.`,
    )
  }
  if (preview.credit_paise > 0) {
    sentences.push(
      extra > 0
        ? `${formatRupees(preview.credit_paise)} more will be kept as credit: nothing else is owed.`
        : `${formatRupees(preview.credit_paise)} extra will be kept as credit: nothing else is owed.`,
    )
  }
  return sentences.length ? sentences.join(' ') : null
}
