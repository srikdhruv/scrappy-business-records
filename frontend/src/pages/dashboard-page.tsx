import { PageHeader } from '@/components/layout/page-header'
import { PlaceholderCard } from '@/components/placeholder-card'
import { currentMonth, formatMonth } from '@/lib/format'

export function DashboardPage() {
  return (
    <>
      <PageHeader title="Dashboard" description={formatMonth(currentMonth())} />
      <div className="grid gap-4 md:grid-cols-3">
        <PlaceholderCard title="Yet to pay">Who hasn’t fully paid this month.</PlaceholderCard>
        <PlaceholderCard title="Backlog">What’s still owed from earlier months.</PlaceholderCard>
        <PlaceholderCard title="Overpaid">Anyone who paid more than their fee.</PlaceholderCard>
      </div>
    </>
  )
}
