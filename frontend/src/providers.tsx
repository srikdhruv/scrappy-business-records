import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { LogPaymentProvider } from '@/components/log-payment'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

/** Everything the app needs around the router. Tests reuse this with their own QueryClient. */
export function Providers({
  queryClient,
  children,
}: {
  queryClient: QueryClient
  children: ReactNode
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <LogPaymentProvider>
          {children}
          <Toaster position="top-center" />
        </LogPaymentProvider>
      </TooltipProvider>
    </QueryClientProvider>
  )
}
