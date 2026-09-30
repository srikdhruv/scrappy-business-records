/**
 * The app-wide "+ Log payment" action (PRD: visible on every page; D5: one click from the
 * dashboard). Anything can open it with an optional prefill:
 *
 *   const { openLogPayment } = useLogPayment()
 *   openLogPayment({ studentId: 3, forMonth: '2026-10', amountPaise: 150000 })
 *
 * PLACEHOLDER: the UI PR replaces the toast below with the real Log payment dialog, rendered
 * once inside <LogPaymentProvider>.
 */
import { PlusIcon } from 'lucide-react'
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface LogPaymentPrefill {
  studentId?: number
  forMonth?: string
  amountPaise?: number
}

interface LogPaymentContextValue {
  openLogPayment: (prefill?: LogPaymentPrefill) => void
}

const LogPaymentContext = createContext<LogPaymentContextValue | null>(null)

export function LogPaymentProvider({ children }: { children: ReactNode }) {
  const openLogPayment = useCallback((_prefill?: LogPaymentPrefill) => {
    toast('Logging payments is coming soon.')
  }, [])
  const value = useMemo(() => ({ openLogPayment }), [openLogPayment])
  return <LogPaymentContext.Provider value={value}>{children}</LogPaymentContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLogPayment(): LogPaymentContextValue {
  const ctx = useContext(LogPaymentContext)
  if (!ctx) throw new Error('useLogPayment must be used inside <LogPaymentProvider>')
  return ctx
}

export function LogPaymentButton({
  className,
  prefill,
  size = 'lg',
}: {
  className?: string
  prefill?: LogPaymentPrefill
  size?: 'default' | 'lg'
}) {
  const { openLogPayment } = useLogPayment()
  return (
    <Button
      size={size}
      className={cn('font-bold shadow-sm', size === 'lg' && 'h-11 px-5 text-base', className)}
      onClick={() => openLogPayment(prefill)}
    >
      <PlusIcon className="size-5" strokeWidth={2.5} aria-hidden />
      Log payment
    </Button>
  )
}
