/** "3 payments (₹4,500) are waiting to be assigned to a student." (Dashboard), with a link. */
import { ArrowRightIcon, CircleHelpIcon } from 'lucide-react'
import { Link } from 'react-router'

import { useUnassignedPayments } from '@/api/queries'
import { formatRupees } from '@/lib/format'
import { plural } from '@/lib/labels'
import { UNASSIGNED_SECTION_ID } from '@/lib/upload'

export function UnassignedBanner() {
  const { data: rows = [] } = useUnassignedPayments()
  if (rows.length === 0) return null
  const total = rows.reduce((sum, r) => sum + r.amount_paise, 0)
  return (
    <div
      role="status"
      className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-partial/30 bg-partial-soft px-4 py-3 text-base"
    >
      <p className="flex items-start gap-2 font-semibold text-foreground">
        <CircleHelpIcon className="mt-0.5 size-5 shrink-0 text-partial" aria-hidden />
        {plural(rows.length, 'payment')} ({formatRupees(total)}) {rows.length === 1 ? 'is' : 'are'}{' '}
        waiting to be assigned to a student.
      </p>
      <Link
        to={`/payments#${UNASSIGNED_SECTION_ID}`}
        className="inline-flex items-center gap-1 rounded font-bold text-primary-strong underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        Assign them
        <ArrowRightIcon className="size-4" aria-hidden />
      </Link>
    </div>
  )
}
