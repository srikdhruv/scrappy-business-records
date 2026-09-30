import { QueryClient } from '@tanstack/react-query'

import { ApiError } from '@/api/client'

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // The server is on the same laptop: data only changes when this UI changes it, and
        // mutations invalidate what they touch. No need to refetch on every window focus.
        refetchOnWindowFocus: false,
        staleTime: 30_000,
        retry: (failureCount, error) =>
          !(error instanceof ApiError && error.status < 500) && failureCount < 2,
      },
    },
  })
}
