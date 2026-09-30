import { PageHeader } from '@/components/layout/page-header'
import { PlaceholderCard } from '@/components/placeholder-card'

export function PaymentsPage() {
  return (
    <>
      <PageHeader title="Payments" description="Every payment, newest first." />
      <PlaceholderCard title="All payments">
        A sortable list of every payment will appear here.
      </PlaceholderCard>
    </>
  )
}
