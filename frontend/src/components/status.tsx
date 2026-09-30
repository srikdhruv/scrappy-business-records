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

import type { BalanceStatus, MonthStatus } from '@/api/schema'
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
  className,
}: {
  status: BalanceStatus
  balancePaise: number
  className?: string
}) {
  const icon = status === 'up_to_date' ? CheckIcon : undefined
  return (
    <StatusPill tone={balanceTone(status)} icon={icon} className={className}>
      {balanceLabel(status, balancePaise)}
    </StatusPill>
  )
}
