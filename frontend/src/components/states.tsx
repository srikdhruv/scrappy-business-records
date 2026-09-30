/** Empty, error and loading states shared by every page. */
import { CloudOffIcon, RotateCwIcon, TriangleAlertIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage, isUnreachable } from '@/lib/errors'
import { cn } from '@/lib/utils'

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode
  title: ReactNode
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-10 text-center',
        className,
      )}
    >
      {icon && <div className="mb-1">{icon}</div>}
      <p className="text-xl font-extrabold text-foreground">{title}</p>
      {children && <div className="max-w-md text-base text-muted-foreground">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

/** A friendly message when data couldn't load, with a Try again button. */
export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown
  onRetry?: () => void
  className?: string
}) {
  const unreachable = isUnreachable(error)
  const Icon = unreachable ? CloudOffIcon : TriangleAlertIcon
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center gap-3 rounded-2xl border border-owed/20 bg-owed-soft/50 px-6 py-10 text-center',
        className,
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-owed-soft text-owed">
        <Icon className="size-6" aria-hidden />
      </span>
      <p className="max-w-md text-lg font-bold text-foreground">
        {unreachable ? errorMessage(error) : 'This didn’t load.'}
      </p>
      {!unreachable && (
        <p className="max-w-md text-base text-muted-foreground">{errorMessage(error)}</p>
      )}
      {onRetry && (
        <Button variant="outline" onClick={onRetry} className="mt-1">
          <RotateCwIcon aria-hidden />
          Try again
        </Button>
      )}
    </div>
  )
}

/** Placeholder rows while a list loads. */
export function ListSkeleton({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-3', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="size-10 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-1/5" />
          </div>
          <Skeleton className="h-8 w-24 rounded-lg" />
        </div>
      ))}
    </div>
  )
}
