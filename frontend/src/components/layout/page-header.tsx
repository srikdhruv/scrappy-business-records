import type { ReactNode } from 'react'

import { LogPaymentButton, type LogPaymentPrefill } from '@/components/log-payment'

/**
 * Title row at the top of every page: title and description on the left; the page's own actions
 * and the "+ Log payment" button (PRD: on every page, top right) on the right.
 */
export function PageHeader({
  title,
  eyebrow,
  description,
  actions,
  logPayment = {},
}: {
  title: ReactNode
  eyebrow?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** Prefill for this page's Log payment button. */
  logPayment?: LogPaymentPrefill
}) {
  return (
    <header className="mb-8 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="min-w-0 space-y-1.5">
        {eyebrow && (
          <p className="text-sm font-bold tracking-wide text-primary-strong uppercase">{eyebrow}</p>
        )}
        {typeof title === 'string' ? (
          <h1 className="text-3xl font-extrabold tracking-tight">{title}</h1>
        ) : (
          title
        )}
        {description && <div className="text-base text-muted-foreground">{description}</div>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {actions}
        <LogPaymentButton prefill={logPayment} />
      </div>
    </header>
  )
}
