/**
 * Before a left month is saved that would make months away owed again (see `awayOwedAgain`),
 * say which, and ask for a tick: "April–June 2026 will be owed again, because they were marked
 * as away. Is that right?"
 */
import { TriangleAlertIcon } from 'lucide-react'

export function AwayWarning({
  spans,
  confirmed,
  onConfirmedChange,
}: {
  spans: string[]
  confirmed: boolean
  onConfirmedChange: (confirmed: boolean) => void
}) {
  if (spans.length === 0) return null
  return (
    <div
      role="alert"
      className="grid gap-2 rounded-xl border border-partial/40 bg-partial-soft px-4 py-3 text-base"
    >
      <p className="flex items-start gap-2">
        <TriangleAlertIcon className="mt-1 size-4 shrink-0 text-partial" aria-hidden />
        <span>
          <strong>{spans.join(' and ')}</strong> will be owed again, because they were marked as
          away. Is that right?
        </span>
      </p>
      <label className="flex items-center gap-2 font-semibold">
        <input
          type="checkbox"
          className="size-4 accent-current"
          checked={confirmed}
          onChange={(e) => onConfirmedChange(e.target.checked)}
        />
        Yes, they owe those months
      </label>
    </div>
  )
}
