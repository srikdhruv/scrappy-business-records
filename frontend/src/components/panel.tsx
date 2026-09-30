import { useId, type ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** A soft, rounded card with a titled header: the main building block of every page. */
export function Panel({
  id,
  headingId,
  title,
  description,
  actions,
  count,
  children,
  className,
  bodyClassName,
}: {
  id?: string
  /** A fixed id for the heading, so focus can be moved to it (e.g. after a save). */
  headingId?: string
  title?: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** A small number shown next to the title (e.g. how many rows). */
  count?: number
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  const autoHeadingId = useId()
  const headingElementId = headingId ?? autoHeadingId
  return (
    <section
      id={id}
      aria-labelledby={title ? headingElementId : undefined}
      className={cn(
        'scroll-mt-6 rounded-2xl border border-border/80 bg-card shadow-soft',
        className,
      )}
    >
      {title && (
        <header className="flex flex-wrap items-start justify-between gap-3 px-6 pt-5 pb-4">
          <div className="min-w-0 space-y-0.5">
            <h2
              id={headingElementId}
              tabIndex={headingId ? -1 : undefined}
              className="flex items-center gap-2.5 rounded-md text-xl font-extrabold outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {title}
              {count !== undefined && (
                <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-muted px-2 text-sm font-bold text-muted-foreground tabular-nums">
                  {count}
                </span>
              )}
            </h2>
            {description && <div className="text-base text-muted-foreground">{description}</div>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(!title && 'pt-2', bodyClassName)}>{children}</div>
    </section>
  )
}
