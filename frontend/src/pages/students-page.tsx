import { PageHeader } from '@/components/layout/page-header'
import { PlaceholderCard } from '@/components/placeholder-card'

export function StudentsPage() {
  return (
    <>
      <PageHeader title="Students" description="Everyone in your classes." />
      <PlaceholderCard title="All students">
        Each student, their status and how long they’ve been with you will appear here.
      </PlaceholderCard>
    </>
  )
}
