import { useState } from 'react'
import { createBrowserRouter, RouterProvider } from 'react-router'

import { createQueryClient } from '@/lib/query-client'
import { Providers } from '@/providers'
import { routes } from '@/routes'

const router = createBrowserRouter(routes)

export default function App() {
  const [queryClient] = useState(createQueryClient)
  return (
    <Providers queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>
  )
}
