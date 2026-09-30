/**
 * A list of payments, sortable by clicking a column heading (P3), with Edit and Delete on each
 * row (P4). Used on the Payments page and on each student's profile.
 */
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, PencilIcon, Trash2Icon } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'

import { useDeletePayment } from '@/api/queries'
import type { PaymentRead } from '@/api/types'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useLogPayment } from '@/components/log-payment'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDate, formatMonth, formatMonthShort, formatRupees } from '@/lib/format'
import { METHOD_LABELS, plural } from '@/lib/labels'
import { cn } from '@/lib/utils'

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
})

const column = createColumnHelper<typeof features, PaymentRead>()
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- columns hold mixed value types
type PaymentColumn = ColumnDef<typeof features, PaymentRead, any>

// Compare plain values; the sorted row model flips the result for descending order.
const compare = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0)

function SortableHeader({
  label,
  sorted,
  onToggle,
  align = 'left',
}: {
  label: string
  sorted: false | 'asc' | 'desc'
  onToggle?: (event: unknown) => void
  align?: 'left' | 'right'
}) {
  const Icon = sorted === 'asc' ? ArrowUpIcon : sorted === 'desc' ? ArrowDownIcon : ArrowUpDownIcon
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        '-mx-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-semibold transition-colors',
        'outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
        sorted && 'text-foreground',
        align === 'right' && 'flex-row-reverse',
      )}
    >
      {label}
      <Icon className={cn('size-4', !sorted && 'opacity-40')} aria-hidden />
    </button>
  )
}

export function PaymentsTable({
  payments,
  showStudent = true,
  empty,
}: {
  payments: PaymentRead[]
  showStudent?: boolean
  /** Shown instead of the table when there are no payments. */
  empty?: ReactNode
}) {
  const { openEditPayment } = useLogPayment()
  const [sorting, setSorting] = useState<SortingState>([{ id: 'paid_on', desc: true }])
  const [toDelete, setToDelete] = useState<PaymentRead | null>(null)
  const deletePayment = useDeletePayment()

  const columns = useMemo(
    (): PaymentColumn[] =>
      [
        column.accessor('paid_on', {
          header: 'Paid on',
          sortFn: (a, b) => compare(a.original.paid_on, b.original.paid_on),
          cell: (info) => formatDate(info.getValue()),
        }),
        showStudent &&
          column.accessor('student_name', {
            id: 'student',
            header: 'Student',
            sortDescFirst: false,
            sortFn: (a, b) =>
              a.original.student_name.localeCompare(b.original.student_name, 'en', {
                sensitivity: 'base',
              }),
            cell: (info) => (
              <Link
                to={`/students/${info.row.original.student_id}`}
                className="inline-block max-w-64 rounded font-bold wrap-break-word whitespace-normal outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {info.getValue()}
              </Link>
            ),
          }),
        column.accessor('amount_paise', {
          id: 'amount',
          header: 'Amount',
          sortFn: (a, b) => compare(a.original.amount_paise, b.original.amount_paise),
          cell: (info) => (
            <span className="font-bold tabular-nums">{formatRupees(info.getValue())}</span>
          ),
        }),
        column.accessor('for_month', {
          header: 'For month',
          sortFn: (a, b) => compare(a.original.for_month, b.original.for_month),
          cell: (info) => (
            <span title={formatMonth(info.getValue())}>{formatMonthShort(info.getValue())}</span>
          ),
        }),
        column.accessor('method', {
          header: 'Method',
          sortDescFirst: false,
          sortFn: (a, b) =>
            compare(METHOD_LABELS[a.original.method], METHOD_LABELS[b.original.method]),
          cell: (info) => (
            <span className="inline-flex h-7 items-center rounded-full bg-muted px-2.5 text-sm font-semibold">
              {METHOD_LABELS[info.getValue()]}
            </span>
          ),
        }),
        column.accessor('note', {
          header: 'Note',
          enableSorting: false,
          cell: (info) => (
            <span
              className="block max-w-56 truncate text-muted-foreground"
              title={info.getValue() ?? ''}
            >
              {info.getValue() ?? ''}
            </span>
          ),
        }),
        column.display({
          id: 'actions',
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => {
            const p = row.original
            const what = `${formatRupees(p.amount_paise)} from ${p.student_name} for ${formatMonth(p.for_month)}`
            return (
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openEditPayment(p)}
                  aria-label={`Edit payment: ${what}`}
                >
                  <PencilIcon aria-hidden />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-owed hover:bg-owed-soft hover:text-owed"
                  onClick={() => setToDelete(p)}
                  aria-label={`Delete payment: ${what}`}
                >
                  <Trash2Icon aria-hidden />
                  Delete
                </Button>
              </div>
            )
          },
        }),
      ].filter((c): c is PaymentColumn => c !== false),
    [showStudent, openEditPayment],
  )

  const table = useTable({
    features,
    columns,
    data: payments,
    state: { sorting },
    onSortingChange: setSorting,
    getRowId: (row) => String(row.id),
  })

  if (payments.length === 0 && empty) return <>{empty}</>

  const total = payments.reduce((sum, p) => sum + p.amount_paise, 0)
  const rightAligned = new Set(['amount'])
  // Below a medium window the note gives way, so Edit and Delete stay on screen.
  const wideOnly = new Set(['note'])

  return (
    <>
      <Table className="md:min-w-[44rem]">
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="hover:bg-transparent">
              {group.headers.map((header) => {
                const col = header.column
                const sorted = col.getIsSorted()
                return (
                  <TableHead
                    key={header.id}
                    aria-sort={
                      sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined
                    }
                    className={cn(
                      'first:pl-6 last:pr-6',
                      rightAligned.has(col.id) && 'text-right',
                      wideOnly.has(col.id) && 'hidden md:table-cell',
                    )}
                  >
                    {col.getCanSort() ? (
                      <SortableHeader
                        label={String(col.columnDef.header)}
                        sorted={sorted}
                        onToggle={col.getToggleSortingHandler()}
                        align={rightAligned.has(col.id) ? 'right' : 'left'}
                      />
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id}>
              {row.getAllCells().map((cell) => (
                <TableCell
                  key={cell.id}
                  className={cn(
                    'first:pl-6 last:pr-6',
                    rightAligned.has(cell.column.id) && 'text-right',
                    wideOnly.has(cell.column.id) && 'hidden md:table-cell',
                  )}
                >
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
        <TableFooter className="bg-muted/40">
          <TableRow className="hover:bg-transparent">
            <TableCell
              colSpan={showStudent ? 2 : 1}
              className="pl-6 text-base text-muted-foreground"
            >
              {plural(payments.length, 'payment')}
            </TableCell>
            <TableCell className="text-right text-base font-extrabold tabular-nums">
              <span className="sr-only">Total: </span>
              {formatRupees(total)}
            </TableCell>
            <TableCell colSpan={4} className="pr-6 text-base text-muted-foreground">
              total
            </TableCell>
          </TableRow>
        </TableFooter>
      </Table>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title="Delete this payment?"
        confirmLabel="Delete payment"
        description={
          toDelete && (
            <>
              <p>
                <strong className="text-foreground">
                  {formatRupees(toDelete.amount_paise)} from {toDelete.student_name} for{' '}
                  {formatMonth(toDelete.for_month)}
                </strong>
                , paid on {formatDate(toDelete.paid_on)} by {METHOD_LABELS[toDelete.method]}, will
                be deleted.
              </p>
              <p>This can’t be undone.</p>
            </>
          )
        }
        onConfirm={async () => {
          if (!toDelete) return
          await deletePayment.mutateAsync(toDelete.id)
          toast.success('Payment deleted', {
            description: `${formatRupees(toDelete.amount_paise)} from ${toDelete.student_name}`,
          })
        }}
      />
    </>
  )
}
