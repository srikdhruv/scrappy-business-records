/**
 * Status badges. One place decides the words and colours, so "Paid" is always green, "Partial"
 * amber, "Unpaid"/"Owes" muted red and "Paid ahead"/"Credit" teal, on every screen.
 */
import {
  CheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  FastForwardIcon,
  PlusIcon,
  type LucideIcon,
} from 'lucide-react'

import type { BalanceStatus, MonthStatus } from '@/api/types'
import { formatMonthShort, formatRupees } from '@/lib/format'
import { balanceLabel, balanceTone, type Tone } from '@/lib/status'
import { cn } from '@/lib/utils'

const TONE_CLASSES: Record<Tone, string> = {
  paid: 'bg-paid-soft text-paid',
  partial: 'bg-partial-soft text-partial',
  owed: 'bg-owed-soft text-owed',
  credit: 'bg-credit-soft text-credit',
  muted: 'bg-muted text-muted-foreground',
}

export function StatusPill({
  tone,
  icon: Icon,
  children,
  className,
}: {
  tone: Tone
  icon?: LucideIcon
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm font-bold whitespace-nowrap',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {Icon && <Icon className="size-3.5" strokeWidth={3} aria-hidden />}
      {children}
    </span>
  )
}

const MONTH_STATUS: Record<MonthStatus, { tone: Tone; label: string; icon?: LucideIcon }> = {
  paid: { tone: 'paid', label: 'Paid', icon: CheckIcon },
  partial: { tone: 'partial', label: 'Partial', icon: CircleDotIcon },
  unpaid: { tone: 'owed', label: 'Unpaid', icon: CircleDashedIcon },
  overpaid: { tone: 'credit', label: 'Paid extra', icon: PlusIcon },
  not_applicable: { tone: 'muted', label: 'No fee' },
}

/**
 * A month's status. Months after the current one aren't due yet, so anything paid for them is
 * "Paid ahead" rather than overpaid.
 */
export function MonthStatusBadge({
  status,
  isDue = true,
  className,
}: {
  status: MonthStatus
  isDue?: boolean
  className?: string
}) {
  if (!isDue && (status === 'paid' || status === 'overpaid' || status === 'partial')) {
    return (
      <StatusPill tone="credit" icon={FastForwardIcon} className={className}>
        {status === 'partial' ? 'Part paid ahead' : 'Paid ahead'}
      </StatusPill>
    )
  }
  if (!isDue && status === 'unpaid') {
    return (
      <StatusPill tone="muted" className={className}>
        Not due yet
      </StatusPill>
    )
  }
  const { tone, label, icon } = MONTH_STATUS[status]
  return (
    <StatusPill tone={tone} icon={icon} className={className}>
      {label}
    </StatusPill>
  )
}

export function BalanceChip({
  status,
  balancePaise,
  creditPaise,
  className,
}: {
  status: BalanceStatus
  balancePaise: number
  creditPaise: number
  className?: string
}) {
  const aheadOnly = status === 'credit' && creditPaise === 0
  const icon = status === 'up_to_date' ? CheckIcon : aheadOnly ? FastForwardIcon : undefined
  return (
    <StatusPill tone={balanceTone(status)} icon={icon} className={className}>
      {balanceLabel(status, balancePaise, creditPaise)}
    </StatusPill>
  )
}

/**
 * "Paid ₹1,500 extra in Feb 2026" (or "₹1,500 paid extra" when the month isn't known): money
 * paid too much for a month, shown next to a student who also owes, so the two can be matched.
 */
export function ExtraPaidNote({
  paise,
  month,
  className,
}: {
  paise: number
  month?: string
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center rounded-full bg-credit-soft px-2 py-0.5 text-xs font-bold text-credit',
        className,
      )}
    >
      {month
        ? `Paid ${formatRupees(paise)} extra in ${formatMonthShort(month)}`
        : `${formatRupees(paise)} paid extra`}
    </span>
  )
}
