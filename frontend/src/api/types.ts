/**
 * The API types the UI works with: the generated ones from `schema.d.ts`, plus fields that the
 * backend PR (#2) adds and that aren't in the generated file yet. The extra fields are optional
 * here, so the UI works against either version of the server.
 *
 * TODO(after #2 merges): run `make gen-api`, then replace these with plain re-exports.
 */
import type * as S from './schema'

export type {
  BalanceStatus,
  DashboardSummary,
  FeeChangeRead,
  LedgerMonth,
  MonthStatus,
  PaymentCreate,
  PaymentMethod,
  PaymentRead,
  PaymentSort,
  PaymentUpdate,
  SortOrder,
  StudentCreate,
  StudentListFilter,
  StudentUpdate,
} from './schema'

/** Fields #2 adds to students (list and detail). */
interface StudentExtras {
  /** Money paid in overpaid due months: extra that could go towards another month. */
  credit_paise?: number
  /** Whole months from joined_month to the current month (server clock). */
  tenure_months?: number
  /** The server's current month, "YYYY-MM". Use it, not the browser clock, for "Member for". */
  current_month?: string
}

export type StudentRead = S.StudentRead & StudentExtras
export type StudentDetail = S.StudentDetail & StudentExtras

export type YetToPayItem = S.YetToPayItem & { credit_paise?: number }
export type BacklogMonth = S.BacklogMonth
export type BacklogItem = S.BacklogItem & { credit_paise?: number }
export type OverpaidItem = S.OverpaidItem & { batch_label?: string | null; phone?: string | null }

export type DashboardResponse = Omit<S.DashboardResponse, 'yet_to_pay' | 'backlog' | 'overpaid'> & {
  yet_to_pay: YetToPayItem[]
  backlog: BacklogItem[]
  overpaid: OverpaidItem[]
}

/**
 * Prefill for Log payment. With #2 both values can be null: nothing is owed now or later
 * (`reason`, e.g. "all_paid"), or the month has no fee (amount null).
 */
export type SuggestedPayment = {
  for_month: string | null
  amount_paise: number | null
  reason?: string | null
}
