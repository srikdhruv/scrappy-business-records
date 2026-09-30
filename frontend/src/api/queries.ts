/**
 * TanStack Query hooks and keys. Add one hook per endpoint here as screens need them, and
 * invalidate by key prefix after mutations, e.g. `queryClient.invalidateQueries({ queryKey:
 * queryKeys.students.all })`.
 */
import { useQuery } from '@tanstack/react-query'

import { api, unwrap } from './client'

export const queryKeys = {
  health: ['health'] as const,
  students: { all: ['students'] as const },
  payments: { all: ['payments'] as const },
  dashboard: { all: ['dashboard'] as const },
}

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: async () => unwrap(await api.GET('/api/health')),
    staleTime: Infinity,
  })
}
