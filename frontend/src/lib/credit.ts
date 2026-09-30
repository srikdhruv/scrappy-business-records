/**
 * The words for extra money that covers other months (PRD ledger rule 10), shared by every
 * screen, so the same thing is always said the same way.
 */
import type { CreditMoveItem, CreditSource, ExtraSent } from '@/api/types'
import { CHECK_MONTHS_AHEAD, type PaymentPreview } from '@/lib/allocation'
import { addMonths, formatDate, formatMonth, formatMonthShort, formatRupees } from '@/lib/format'

/** "a", "a and b", "a, b and c". */
function listed(phrases: string[]): string {
  return phrases.length <= 1
    ? phrases.join('')
    : `${phrases.slice(0, -1).join(', ')} and ${phrases.at(-1)}`
}

/** Months in a row, oldest first: [["2026-10", "2026-11"], ["2027-02"]]. */
function runs(months: readonly string[]): string[][] {
  const out: string[][] = []
  for (const m of [...months].sort()) {
    const last = out.at(-1)
    if (last && addMonths(last.at(-1)!, 1) === m) last.push(m)
    else out.push([m])
  }
  return out
}

/** "Aug 2026", "Oct 2026 to Sep 2028", or "Jun 2026 and Aug 2026 to Sep 2026". */
export function monthRanges(months: readonly string[]): string {
  return listed(
    runs(months).map((r) =>
      r.length === 1
        ? formatMonthShort(r[0]!)
        : `${formatMonthShort(r[0]!)} to ${formatMonthShort(r.at(-1)!)}`,
    ),
  )
}

/**
 * The notes on a month in the profile's table, one per source and one per run of months:
 * "₹1,500 credit from the 5 Sep 2026 payment (for Sep 2026)" (payments paid the same day for
 * the same month added together) and "₹36,000 extra → Oct 2026 to Sep 2028".
 */
export function monthNotes(m: {
  month: string
  credit_sources: readonly CreditSource[]
  extra_sent: readonly ExtraSent[]
}): { key: string; text: string }[] {
  const from = new Map<string, { source: CreditSource; ids: number[] }>()
  for (const c of m.credit_sources) {
    const key = `${c.paid_on}|${c.for_month}`
    const seen = from.get(key)
    if (seen) {
      seen.source = { ...seen.source, amount_paise: seen.source.amount_paise + c.amount_paise }
      seen.ids.push(c.payment_id)
    } else from.set(key, { source: c, ids: [c.payment_id] })
  }
  const notes = [...from.values()].map(({ source, ids }) => ({
    key: `from-${ids.join('-')}-${m.month}`,
    text: creditSourceText(source),
  }))
  for (const r of runs(m.extra_sent.map((e) => e.to_month))) {
    const amount = m.extra_sent
      .filter((e) => r.includes(e.to_month))
      .reduce((sum, e) => sum + e.amount_paise, 0)
    notes.push({
      key: `to-${m.month}-${r[0]}`,
      text: `${formatRupees(amount)} extra → ${monthRanges(r)}`,
    })
  }
  return notes
}

/** "₹1,500 credit from the 5 Sep 2026 payment (for Sep 2026)": on the month it pays. */
export function creditSourceText(source: CreditSource): string {
  return `${formatRupees(source.amount_paise)} credit from the ${formatDate(source.paid_on)} payment (for ${formatMonthShort(source.for_month)})`
}

/** "₹1,500 extra → Aug 2026": on the month whose payment had it. */
export function extraSentText(sent: ExtraSent): string {
  return `${formatRupees(sent.amount_paise)} extra → ${formatMonthShort(sent.to_month)}`
}

/**
 * "₹1,500 went to Aug 2026", "₹36,000 went to Oct 2026 to Sep 2028", and "₹500 kept as credit":
 * on a payment. Null when all of it paid its own month.
 */
export function paymentUseText(p: {
  extra_sent: ExtraSent[]
  extra_unused_paise: number
}): string | null {
  const sent = p.extra_sent.reduce((sum, e) => sum + e.amount_paise, 0)
  const moved =
    sent > 0
      ? `${formatRupees(sent)} went to ${monthRanges(p.extra_sent.map((e) => e.to_month))}`
      : ''
  const kept =
    p.extra_unused_paise > 0 ? `${formatRupees(p.extra_unused_paise)} kept as credit` : ''
  return [moved, kept].filter(Boolean).join('; ') || null
}

/**
 * Why a payment may be a slip of the finger (`needs_check`), always with its reason: "Check:
 * this ₹15,000 payment pays up to Jun 2027 — 9 months ahead", "Check: this ₹2,500 payment —
 * ₹500 isn't needed by any month", or both.
 */
export function checkText(p: {
  amount_paise: number
  paysUntil: string
  monthsAhead: number
  unused_paise: number
  /** More than one payment (made the same day, for the same month). */
  several?: boolean
}): string {
  const reasons = [
    p.monthsAhead >= CHECK_MONTHS_AHEAD &&
      `pays up to ${formatMonthShort(p.paysUntil)} — ${p.monthsAhead} months ahead`,
    p.unused_paise > 0 && `${formatRupees(p.unused_paise)} isn’t needed by any month`,
  ].filter(Boolean) as string[]
  const what = p.several
    ? `these payments (${formatRupees(p.amount_paise)})`
    : `this ${formatRupees(p.amount_paise)} payment`
  if (reasons.length === 0) return `Check: ${what}`
  const [first, ...rest] = reasons
  const joined = [first!.startsWith('pays') ? first : `— ${first}`, ...rest].join('; ')
  return `Check: ${what} ${joined}`
}

/** Dashboard "Extra money used" rows: one per payment (payments made the same day for the same
 * month together), however many months it paid. */
export interface MoveGroup {
  key: string
  student_id: number
  student_name: string
  paid_on: string
  from_month: string
  to_months: string[]
  amount_paise: number
  payment_ids: number[]
  payment_amount_paise: number
  pays_until: string
  months_ahead: number
  unused_paise: number
  needs_check: boolean
}

export function groupMoves(items: readonly CreditMoveItem[]): MoveGroup[] {
  const groups = new Map<string, MoveGroup>()
  for (const item of items) {
    const key = `${item.student_id}|${item.paid_on}|${item.from_month}`
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        student_id: item.student_id,
        student_name: item.student_name,
        paid_on: item.paid_on,
        from_month: item.from_month,
        to_months: [],
        amount_paise: 0,
        payment_ids: [],
        payment_amount_paise: 0,
        pays_until: item.payment_pays_until,
        months_ahead: 0,
        unused_paise: 0,
        needs_check: false,
      }
      groups.set(key, g)
    }
    if (!g.to_months.includes(item.to_month)) g.to_months.push(item.to_month)
    g.amount_paise += item.amount_paise
    if (!g.payment_ids.includes(item.payment_id)) {
      g.payment_ids.push(item.payment_id)
      g.payment_amount_paise += item.payment_amount_paise
      g.unused_paise += item.payment_extra_unused_paise
    }
    g.months_ahead = Math.max(g.months_ahead, item.payment_months_ahead)
    if (item.payment_pays_until > g.pays_until) g.pays_until = item.payment_pays_until
    g.needs_check ||= item.payment_needs_check
  }
  return [...groups.values()]
}

const WAS: Record<PaymentPreview['covers'][number]['was'], string> = {
  unpaid: 'unpaid',
  part_paid: 'part paid',
  ahead: 'ahead',
}

/**
 * "August 2026 (unpaid)", "October 2026 and part of November 2026 ahead", or a run in short;
 * months owed first, "then" months ahead.
 */
function coverPhrase(covers: PaymentPreview['covers']): string {
  const one = (c: PaymentPreview['covers'][number]) =>
    `${c.full ? '' : 'part of '}${formatMonth(c.month)}`
  const due = covers.filter((c) => c.was !== 'ahead')
  const ahead = covers.filter((c) => c.was === 'ahead')
  const owed =
    due.length <= 3
      ? listed(due.map((c) => `${one(c)} (${WAS[c.was]})`))
      : `${due.length} months still owed (${formatMonth(due[0]!.month)} to ${formatMonth(due.at(-1)!.month)})`
  const last = ahead.at(-1)
  const later = !last
    ? ''
    : ahead.length <= 2
      ? `${listed(ahead.map(one))} ahead`
      : `${ahead.length} months ahead (${formatMonth(ahead[0]!.month)} to ${formatMonth(last.month)}${last.full ? '' : ', the last in part'})`
  return owed && later ? `${owed}, then ${later}` : owed || later
}

/**
 * What saving a payment will do with its money above its own month's fee, e.g. "₹1,500 more
 * than the September fee: it will pay August 2026 (unpaid)." Null when there is none. The
 * amounts are this payment's own, as its row will say once saved.
 */
export function previewText(preview: PaymentPreview): string | null {
  const sent = preview.covers.reduce((sum, c) => sum + c.amount_paise, 0)
  const extra = sent + preview.credit_paise
  if (extra === 0) return null
  const name = formatMonth(preview.own_month).split(' ')[0]
  const head =
    preview.own_expected_paise === 0
      ? `No fee is due for ${name}, so all ${formatRupees(extra)} is extra`
      : preview.own_paise === 0
        ? `${name} is already paid, so all ${formatRupees(extra)} is extra`
        : preview.own_paise < preview.own_expected_paise
          ? `${formatRupees(extra)} more than what’s left of the ${name} fee`
          : `${formatRupees(extra)} more than the ${name} fee`
  const parts: string[] = []
  if (sent > 0) parts.push(`it will pay ${coverPhrase(preview.covers)}`)
  if (preview.credit_paise > 0) {
    parts.push(
      sent > 0
        ? `and ${formatRupees(preview.credit_paise)} will be kept as credit (nothing else is owed)`
        : 'nothing else is owed, so it will be kept as credit',
    )
  }
  return `${head}: ${parts.join(', ')}.`
}
