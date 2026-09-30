/**
 * TanStack Query hooks and keys, one per endpoint.
 *
 * Every write can change dues, balances and the dashboard, so all mutations invalidate the three
 * roots (students, payments, dashboard) through `invalidateRecords`. At this app's size that's
 * instant, and it means no screen can ever show a stale number after a save.
 */
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'

import { api, unwrap } from './client'
import type {
  BatchCreate,
  BatchOverview,
  BatchRead,
  BatchUpdate,
  DashboardResponse,
  LabelConversion,
  LabelPreview,
  PaymentCreate,
  PaymentUpdate,
  StudentCreate,
  StudentDetail,
  StudentListFilter,
  StudentRead,
  StudentUpdate,
  SuggestedPayment,
} from './types'

export interface PaymentFilters {
  student_id?: number
  month?: string
  q?: string
}

export const queryKeys = {
  health: ['health'] as const,
  students: {
    all: ['students'] as const,
    list: (status: StudentListFilter) => ['students', 'list', status] as const,
    detail: (id: number) => ['students', 'detail', id] as const,
    suggestion: (id: number) => ['students', 'detail', id, 'suggest-payment'] as const,
  },
  payments: {
    all: ['payments'] as const,
    list: (filters: PaymentFilters) => ['payments', 'list', filters] as const,
  },
  dashboard: {
    all: ['dashboard'] as const,
    month: (month: string) => ['dashboard', month] as const,
  },
  batches: {
    all: ['batches'] as const,
    list: ['batches', 'list'] as const,
    overview: (month: string) => ['batches', 'summary', month] as const,
    labels: ['batches', 'from-labels'] as const,
  },
}

/** Refetch everything that a student, payment or batch change can affect. */
export function invalidateRecords(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.students.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.payments.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.batches.all }),
  ])
}

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: async () => unwrap(await api.GET('/api/health')),
    staleTime: Infinity,
  })
}

/**
 * Is the app's server answering? Checked every 15 seconds while the window is visible, so a
 * page left open can say so instead of quietly showing numbers that may be out of date.
 */
export function useServerReachable() {
  const ping = useQuery({
    queryKey: ['health', 'ping'],
    queryFn: async () => unwrap(await api.GET('/api/health')),
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 0,
  })
  return !ping.isError
}

/** The server's current month ("YYYY-MM"), or undefined until it has answered. */
export function useServerMonth(): string | undefined {
  const { data } = useQuery({
    queryKey: queryKeys.dashboard.month('current'),
    queryFn: async (): Promise<DashboardResponse> => unwrap(await api.GET('/api/dashboard')),
    select: (d) => d.current_month,
  })
  return data
}

// ---- Dashboard ----------------------------------------------------------------------------------

/** The dashboard for `month`, or for the server's current month when it's undefined. */
export function useDashboard(month: string | undefined) {
  return useQuery({
    queryKey: queryKeys.dashboard.month(month ?? 'current'),
    queryFn: async (): Promise<DashboardResponse> =>
      unwrap(await api.GET('/api/dashboard', { params: { query: { month } } })),
    placeholderData: keepPreviousData,
  })
}

// ---- Students -----------------------------------------------------------------------------------

/** Students sorted by name. Search and tabs filter this list on the client, so typing is instant. */
export function useStudents(status: StudentListFilter = 'all') {
  return useQuery({
    queryKey: queryKeys.students.list(status),
    queryFn: async (): Promise<StudentRead[]> =>
      unwrap(await api.GET('/api/students', { params: { query: { status } } })),
  })
}

export function useStudent(id: number | undefined) {
  return useQuery({
    queryKey: queryKeys.students.detail(id ?? 0),
    queryFn: async (): Promise<StudentDetail> =>
      unwrap(
        await api.GET('/api/students/{student_id}', { params: { path: { student_id: id! } } }),
      ),
    enabled: id !== undefined && id > 0,
  })
}

export function useSuggestedPayment(id: number | undefined) {
  return useQuery({
    queryKey: queryKeys.students.suggestion(id ?? 0),
    queryFn: async (): Promise<SuggestedPayment> =>
      unwrap(
        await api.GET('/api/students/{student_id}/suggest-payment', {
          params: { path: { student_id: id! } },
        }),
      ),
    enabled: id !== undefined && id > 0,
    staleTime: 0,
  })
}

export function useCreateStudent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body: StudentCreate): Promise<StudentDetail> =>
      unwrap(await api.POST('/api/students', { body })),
    onSuccess: () => invalidateRecords(queryClient),
  })
}

export function useUpdateStudent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, body }: { id: number; body: StudentUpdate }): Promise<StudentDetail> =>
      unwrap(
        await api.PATCH('/api/students/{student_id}', {
          params: { path: { student_id: id } },
          body,
        }),
      ),
    onSuccess: (student) => {
      queryClient.setQueryData(queryKeys.students.detail(student.id), student)
      return invalidateRecords(queryClient)
    },
  })
}

/** A student who left is coming again from `fromMonth`; the months away get no fee. */
export function useReturnStudent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      id,
      fromMonth,
      feePaise,
    }: {
      id: number
      fromMonth: string
      feePaise?: number
    }) =>
      unwrap(
        await api.POST('/api/students/{student_id}/return', {
          params: { path: { student_id: id } },
          body: { from_month: fromMonth, monthly_fee_paise: feePaise },
        }),
      ),
    onSuccess: (student) => {
      queryClient.setQueryData(queryKeys.students.detail(student.id), student)
      return invalidateRecords(queryClient)
    },
  })
}

/** Remove a fee change that hasn't started yet (never the first fee). */
export function useDeleteFeeChange() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ studentId, feeChangeId }: { studentId: number; feeChangeId: number }) =>
      unwrap(
        await api.DELETE('/api/students/{student_id}/fee-changes/{fee_change_id}', {
          params: { path: { student_id: studentId, fee_change_id: feeChangeId } },
        }),
      ),
    onSuccess: () => invalidateRecords(queryClient),
  })
}

export function useDeleteStudent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) =>
      unwrap(
        await api.DELETE('/api/students/{student_id}', { params: { path: { student_id: id } } }),
      ),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.students.detail(id) })
      return invalidateRecords(queryClient)
    },
  })
}

// ---- Payments -----------------------------------------------------------------------------------

export function usePayments(filters: PaymentFilters = {}) {
  return useQuery({
    queryKey: queryKeys.payments.list(filters),
    queryFn: async () =>
      unwrap(
        await api.GET('/api/payments', {
          params: {
            query: {
              student_id: filters.student_id,
              month: filters.month,
              q: filters.q || undefined,
            },
          },
        }),
      ),
    placeholderData: keepPreviousData,
  })
}

/**
 * One student's payments, or nothing until a student is chosen. Unlike `usePayments`, it never
 * shows the previous student's payments while the next one's load (the Log payment preview
 * must not mix two students up).
 */
export function useStudentPayments(studentId: number | undefined) {
  const filters: PaymentFilters = { student_id: studentId }
  return useQuery({
    queryKey: queryKeys.payments.list(filters),
    queryFn: async () =>
      unwrap(await api.GET('/api/payments', { params: { query: { student_id: studentId } } })),
    enabled: studentId !== undefined,
  })
}

export function useCreatePayment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body: PaymentCreate) => unwrap(await api.POST('/api/payments', { body })),
    onSuccess: () => invalidateRecords(queryClient),
  })
}

export function useUpdatePayment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, body }: { id: number; body: PaymentUpdate }) =>
      unwrap(
        await api.PATCH('/api/payments/{payment_id}', {
          params: { path: { payment_id: id } },
          body,
        }),
      ),
    onSuccess: () => invalidateRecords(queryClient),
  })
}

export function useDeletePayment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) =>
      unwrap(
        await api.DELETE('/api/payments/{payment_id}', { params: { path: { payment_id: id } } }),
      ),
    onSuccess: () => invalidateRecords(queryClient),
  })
}

// ---- Batches ------------------------------------------------------------------------------------

/** Every batch, sorted by name, with how many students are in it. */
export function useBatches() {
  return useQuery({
    queryKey: queryKeys.batches.list,
    queryFn: async (): Promise<BatchRead[]> => unwrap(await api.GET('/api/batches')),
  })
}

/** Each batch's fees for `month` (the server's current month when undefined). */
export function useBatchOverview(month: string | undefined) {
  return useQuery({
    queryKey: queryKeys.batches.overview(month ?? 'current'),
    queryFn: async (): Promise<BatchOverview> =>
      unwrap(await api.GET('/api/batches/summary', { params: { query: { month } } })),
    placeholderData: keepPreviousData,
  })
}

/** What "Create batches from existing labels" would do. */
export function useLabelPreview() {
  return useQuery({
    queryKey: queryKeys.batches.labels,
    queryFn: async (): Promise<LabelPreview> => unwrap(await api.GET('/api/batches/from-labels')),
  })
}

export function useCreateBatch() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (body: BatchCreate): Promise<BatchRead> =>
      unwrap(await api.POST('/api/batches', { body })),
    onSuccess: () => invalidateRecords(queryClient),
  })
}

export function useUpdateBatch() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, body }: { id: number; body: BatchUpdate }): Promise<BatchRead> =>
      unwrap(
        await api.PATCH('/api/batches/{batch_id}', { params: { path: { batch_id: id } }, body }),
      ),
    onSuccess: () => invalidateRecords(queryClient),
  })
}

/** Delete a batch; its students stay, in no batch. */
export function useDeleteBatch() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) =>
      unwrap(await api.DELETE('/api/batches/{batch_id}', { params: { path: { batch_id: id } } })),
    onSuccess: () => invalidateRecords(queryClient),
  })
}

export function useConvertLabels() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<LabelConversion> =>
      unwrap(await api.POST('/api/batches/from-labels')),
    onSuccess: () => invalidateRecords(queryClient),
  })
}
