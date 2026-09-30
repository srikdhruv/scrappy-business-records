import { Link, useParams } from 'react-router'

import { PageHeader } from '@/components/layout/page-header'
import { PlaceholderCard } from '@/components/placeholder-card'

export function StudentProfilePage() {
  const { id } = useParams<{ id: string }>()
  return (
    <>
      <p className="mb-2">
        <Link to="/students" className="text-sm font-semibold text-primary-strong hover:underline">
          ← All students
        </Link>
      </p>
      <PageHeader title="Student" description={`Profile #${id ?? ''}`} />
      <PlaceholderCard title="Profile">
        Details, month-by-month status and payments will appear here.
      </PlaceholderCard>
    </>
  )
}
