/**
 * TanStack Query hooks and keys, one per endpoint.
 *
 * Every write can change dues, balances, the dashboard and the report, so all mutations invalidate
 * the four roots (students, payments, dashboard, report) through `invalidateRecords`. At this
 * app's size that's instant, and it means no screen can ever show a stale number after a save.
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
  DashboardResponse,
  PaymentCreate,
  ReportResponse,
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
  report: {
    all: ['report'] as const,
    month: (month: string) => ['report', month] as const,
  },
}

/** Refetch everything that a student or payment change can affect. */
export function invalidateRecords(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.students.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.payments.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all }),
    queryClient.invalidateQueries({ queryKey: queryKeys.report.all }),
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

// ---- Monthly report ----------------------------------------------------------------------------

/** The monthly report for `month`, or for the server's current month when it's undefined. */
export function useReport(month: string | undefined) {
  return useQuery({
    queryKey: queryKeys.report.month(month ?? 'current'),
    queryFn: async (): Promise<ReportResponse> =>
      unwrap(await api.GET('/api/report', { params: { query: { month } } })),
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
