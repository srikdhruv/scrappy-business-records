/**
 * Every payment (P3, P4): filter by student, month, method or a search, sort by any column, and
 * fix mistakes with Edit or Delete. Filters live in the address bar, so Back keeps them.
 */
import { ReceiptIndianRupeeIcon, SearchIcon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'

import { usePayments } from '@/api/queries'
import type { PaymentMethod } from '@/api/types'
import { PageHeader } from '@/components/layout/page-header'
import { MonthPicker } from '@/components/month-picker'
import { Panel } from '@/components/panel'
import { PaymentsTable } from '@/components/payments-table'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/states'
import { StudentCombobox } from '@/components/student-combobox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { METHOD_LABELS } from '@/lib/labels'
import { cn } from '@/lib/utils'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const METHODS = Object.keys(METHOD_LABELS) as PaymentMethod[]

/** `value`, but only after it has stopped changing for `ms`. */
function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

export function PaymentsPage() {
  const [params, setParams] = useSearchParams()
  const studentParam = Number(params.get('student'))
  const studentId = Number.isInteger(studentParam) && studentParam > 0 ? studentParam : undefined
  const monthParam = params.get('month')
  const month = monthParam && MONTH_RE.test(monthParam) ? monthParam : undefined
  const methodParam = params.get('method') as PaymentMethod | null
  const method = methodParam && METHODS.includes(methodParam) ? methodParam : undefined
  // The search box filters as you type, a moment after the last key. It lives in the page, not
  // the address bar, so a late keystroke can never undo a filter picked meanwhile. A link can
  // still start with a search (?q=...).
  const [search, setSearch] = useState(() => params.get('q') ?? '')
  const q = useDebouncedValue(search.trim(), 250)

  function update(changes: Record<string, string | null>) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const [key, value] of Object.entries(changes)) {
          if (value === null || value === '') next.delete(key)
          else next.set(key, value)
        }
        return next
      },
      { replace: true },
    )
  }

  const payments = usePayments({ student_id: studentId, month, q: q || undefined })
  // Memoized: the table must get the same array until something really changes.
  const shown = useMemo(
    () => (payments.data ?? []).filter((p) => !method || p.method === method),
    [payments.data, method],
  )
  const filtered = Boolean(studentId || month || method || search.trim())

  const clearAll = () => {
    setSearch('')
    setParams({}, { replace: true })
  }

  return (
    <>
      <PageHeader
        title="Payments"
        description="Every payment you’ve logged. Click a column heading to sort."
      />

      <Panel bodyClassName="pt-0">
        <div
          className="flex flex-wrap items-end gap-3 border-b border-border/70 px-6 py-5"
          role="search"
          aria-label="Filter payments"
        >
          <div className="relative min-w-56 flex-[2_1_14rem]">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search names and notes"
              aria-label="Search payments by student name or note"
              className="pl-10"
            />
          </div>
          <div className="min-w-52 flex-[1.5_1_13rem]">
            <StudentCombobox
              value={studentId ?? null}
              onChange={(id) => update({ student: id ? String(id) : null })}
              placeholder="All students"
              clearLabel="All students"
              label="Filter by student"
              className="h-11"
            />
          </div>
          <div className="min-w-44 flex-[1_1_11rem]">
            <MonthPicker
              value={month ?? null}
              onChange={(m) => update({ month: m })}
              placeholder="All months"
              clearLabel="All months"
              label="Filter by month"
            />
          </div>
          <div className="min-w-36 flex-[1_1_9rem]">
            <Select
              value={method ?? 'all'}
              onValueChange={(v) => update({ method: v === 'all' ? null : v })}
            >
              <SelectTrigger className="h-11! w-full bg-card text-base" aria-label="Payment method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All methods</SelectItem>
                {METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {METHOD_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {filtered && (
            <Button variant="ghost" onClick={clearAll} className="h-11">
              <XIcon aria-hidden />
              Clear filters
            </Button>
          )}
        </div>

        {payments.error && !payments.data ? (
          <div className="p-6">
            <ErrorState error={payments.error} onRetry={() => void payments.refetch()} />
          </div>
        ) : !payments.data ? (
          <div className="p-6">
            <ListSkeleton rows={8} />
          </div>
        ) : (
          <div className={cn('transition-opacity', payments.isPlaceholderData && 'opacity-60')}>
            <PaymentsTable
              payments={shown}
              empty={
                filtered ? (
                  <EmptyState
                    title="No payments match these filters."
                    action={
                      <Button variant="outline" onClick={clearAll}>
                        Clear filters
                      </Button>
                    }
                  />
                ) : (
                  <EmptyState
                    icon={
                      <ReceiptIndianRupeeIcon className="size-10 text-primary-strong" aria-hidden />
                    }
                    title="No payments yet."
                  >
                    When someone pays you, click <strong>Log payment</strong> at the top right.
                  </EmptyState>
                )
              }
            />
          </div>
        )}
      </Panel>
    </>
  )
}
