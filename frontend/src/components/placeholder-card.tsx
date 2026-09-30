import type { ReactNode } from 'react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/** Temporary content for pages that the UI PR will build. */
export function PlaceholderCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="rounded-2xl border border-border shadow-sm ring-0">
      <CardHeader>
        <CardTitle className="text-lg font-bold">{title}</CardTitle>
        <CardDescription className="text-base">{children}</CardDescription>
      </CardHeader>
      <CardContent />
    </Card>
  )
}
