/**
 * Links for the Excel downloads. Each is a normal browser download from the app's own server
 * (`/api/export/...`), so the file lands in the Downloads folder like any other.
 */
import type { ExportTemplateKind, PaymentMethod, PaymentSort } from '@/api/types'

function url(path: string, params: Record<string, string | number | undefined | null>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value))
  }
  const text = query.toString()
  return text ? `${path}?${text}` : path
}

/** The students on the Students page: this tab, and what's typed in the search. */
export function studentsDownloadUrl(tab: 'active' | 'left' | 'all', search: string): string {
  return url('/api/export/students.xlsx', { status: tab, q: search.trim() || undefined })
}

export interface PaymentsShown {
  studentId?: number
  month?: string
  q?: string
  method?: PaymentMethod
  /** The column the table is sorted by (its id), and which way; none means newest first. */
  sort?: { id: string; desc: boolean }
}

const SORTS: Record<string, PaymentSort> = {
  paid_on: 'paid_on',
  student: 'student',
  amount: 'amount',
  for_month: 'for_month',
  method: 'method',
}

/** The payments on the Payments page: its filters, and the table's order. */
export function paymentsDownloadUrl(shown: PaymentsShown): string {
  const sort = shown.sort && SORTS[shown.sort.id]
  return url('/api/export/payments.xlsx', {
    student_id: shown.studentId,
    month: shown.month,
    q: shown.q?.trim() || undefined,
    method: shown.method,
    sort: sort ?? undefined,
    order: sort ? (shown.sort!.desc ? 'desc' : 'asc') : undefined,
  })
}

export const EVERYTHING_DOWNLOAD_URL = '/api/export/everything.xlsx'

export function templateUrl(kind: ExportTemplateKind): string {
  return url('/api/import/template.xlsx', { kind })
}
