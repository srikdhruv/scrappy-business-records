import { Link } from 'react-router'

import { PageHeader } from '@/components/layout/page-header'

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" description="There’s nothing at this address." />
      <Link to="/" className="font-semibold text-primary-strong hover:underline">
        Go to the dashboard
      </Link>
    </>
  )
}
