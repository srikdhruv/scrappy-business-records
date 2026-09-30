/**
 * One batch on the "All batches" tab: its name, place, days and times, how many students, the
 * month's fees and how much of them is paid. The whole card opens the batch's tab; Edit and
 * Delete sit on top of it.
 */
import { CalendarDaysIcon, MapPinIcon, PencilIcon, Trash2Icon, UsersIcon } from 'lucide-react'
import { Link } from 'react-router'

import type { BatchRead, BatchSummary } from '@/api/types'
import { PaidBar } from '@/components/batches/paid-bar'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { batchPath, formatSchedule } from '@/lib/batches'
import { formatRupees } from '@/lib/format'
import { plural } from '@/lib/labels'
import { cn } from '@/lib/utils'

export function BatchCard({
  batch,
  summary,
  month,
  onEdit,
  onDelete,
}: {
  batch: BatchRead
  summary: BatchSummary | undefined
  month?: string
  onEdit: () => void
  onDelete: () => void
}) {
  const schedule = formatSchedule(batch)
  return (
    <article
      className="group relative flex flex-col gap-4 rounded-2xl border border-border/80 bg-card p-5 shadow-soft transition-shadow focus-within:ring-3 focus-within:ring-ring/50 hover:border-primary/60 hover:shadow-md"
      aria-labelledby={`batch-${batch.id}-name`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 id={`batch-${batch.id}-name`} className="min-w-0 text-lg leading-snug font-extrabold">
          {/* The link covers the whole card (after:), so a click anywhere opens the batch. */}
          <Link
            to={batchPath(batch.id, month)}
            title={batch.name.length > 60 ? batch.name : undefined}
            className="line-clamp-2 wrap-break-word outline-none after:absolute after:inset-0 after:rounded-2xl after:content-['']"
          >
            {batch.name}
          </Link>
        </h3>
        <div className="relative z-10 -mt-1 -mr-2 flex shrink-0 gap-0.5">
          <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Edit ${batch.name}`}>
            <PencilIcon className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onDelete}
            aria-label={`Delete ${batch.name}`}
            className="hover:bg-owed-soft hover:text-owed"
          >
            <Trash2Icon className="size-4" />
          </Button>
        </div>
      </div>

      <dl className="-mt-2 grid gap-1 text-base text-muted-foreground">
        {batch.location && (
          <Line icon={<MapPinIcon />} label="Where">
            {batch.location}
          </Line>
        )}
        {schedule && (
          <Line icon={<CalendarDaysIcon />} label="When">
            {schedule}
          </Line>
        )}
        <Line icon={<UsersIcon />} label="Students">
          {batch.active_student_count === 0
            ? 'No students yet'
            : plural(batch.active_student_count, 'student')}
          {summary && summary.expected_paise > 0 && (
            <> · {formatRupees(summary.expected_paise)} this month</>
          )}
        </Line>
      </dl>

      <div className="mt-auto">
        {summary ? <PaidBar summary={summary} /> : <Skeleton className="h-9 w-full" />}
      </div>
    </article>
  )
}

function Line({
  icon,
  label,
  children,
}: {
  icon: React.ReactElement
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <dt className="sr-only">{label}</dt>
      <span className="mt-1 shrink-0 text-primary-strong [&>svg]:size-4" aria-hidden>
        {icon}
      </span>
      <dd className="min-w-0 wrap-break-word">{children}</dd>
    </div>
  )
}

/** The students in no batch, as a quieter card after the batches. */
export function NoBatchCard({
  count,
  summary,
  month,
}: {
  count: number
  summary: BatchSummary | undefined
  month?: string
}) {
  return (
    <article
      className={cn(
        'relative flex flex-col gap-3 rounded-2xl border border-dashed border-border bg-card/60 p-5 transition-colors focus-within:ring-3 focus-within:ring-ring/50 hover:border-primary/60',
      )}
    >
      <h3 className="text-lg font-extrabold">
        <Link
          to={batchPath('none', month)}
          className="outline-none after:absolute after:inset-0 after:rounded-2xl after:content-['']"
        >
          No batch
        </Link>
      </h3>
      <p className="-mt-1 text-base text-muted-foreground">
        {plural(count, 'student')} not in a batch yet.
      </p>
      {summary && summary.expected_paise > 0 && (
        <div className="mt-auto">
          <PaidBar summary={summary} />
        </div>
      )}
    </article>
  )
}
