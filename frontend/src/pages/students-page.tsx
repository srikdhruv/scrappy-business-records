/**
 * Students, by batch (PRD scope 6). Tabs across the top: All batches | each batch | No batch.
 *
 * - **All batches** (`/students`): a card per batch (place, days and times, students, the
 *   month's fees and how much is paid), New batch, Edit and Delete, turning old labels into
 *   batches, and below them every student, to search, sort, filter and group.
 * - **A batch** (`/students/batch/3`): its details and the month's numbers with a % paid bar,
 *   Edit batch, + Add student (with its fee filled in), and its students.
 * - **No batch** (`/students/batch/none`): the students who aren't in one yet.
 *
 * `?month=YYYY-MM` picks the month for the numbers; it's kept when switching tabs.
 */
import { PencilIcon, PlusIcon, Trash2Icon, UserPlusIcon, UsersIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { toast } from 'sonner'

import {
  useBatchOverview,
  useBatches,
  useDeleteBatch,
  useServerMonth,
  useStudents,
} from '@/api/queries'
import type { BatchRead, BatchSummary } from '@/api/types'
import { BatchCard, NoBatchCard } from '@/components/batches/batch-card'
import { BatchFormDialog } from '@/components/batches/batch-form'
import { BatchNav, type BatchTab } from '@/components/batches/batch-nav'
import { ConvertLabelsButton } from '@/components/batches/convert-labels'
import { MonthNav } from '@/components/batches/month-nav'
import { PaidBar } from '@/components/batches/paid-bar'
import { StudentsTable } from '@/components/batches/students-table'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/layout/page-header'
import { Panel } from '@/components/panel'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/states'
import { StudentFormDialog } from '@/components/student-form'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { batchPath, formatSchedule } from '@/lib/batches'
import { formatMonth, formatRupees } from '@/lib/format'
import { plural } from '@/lib/labels'

/** How many batch cards show before "Show all". */
const CARDS_SHOWN = 9
const MONTH_RE = /^20\d{2}-(0[1-9]|1[0-2])$/

function useTab(): BatchTab {
  const { batchId } = useParams()
  if (batchId === undefined) return 'all'
  if (batchId === 'none') return 'none'
  const id = Number(batchId)
  return Number.isInteger(id) && id > 0 ? id : -1
}

export function StudentsPage() {
  const tab = useTab()
  const [params, setParams] = useSearchParams()
  const monthParam = params.get('month')
  const now = useServerMonth()
  const month = monthParam && MONTH_RE.test(monthParam) ? monthParam : now
  const setMonth = (m: string) =>
    setParams(m === now ? {} : { month: m }, { replace: true, preventScrollReset: true })

  const students = useStudents('all')
  const batches = useBatches()
  const overview = useBatchOverview(month)
  const [newStudent, setNewStudent] = useState<{ open: boolean; batchId: number | null }>({
    open: false,
    batchId: null,
  })
  const [batchForm, setBatchForm] = useState<{ open: boolean; batch?: BatchRead }>({
    open: false,
  })
  const [deleting, setDeleting] = useState<BatchRead | null>(null)
  const deleteBatch = useDeleteBatch()
  const navigate = useNavigate()

  const all = students.data ?? []
  const list = batches.data ?? []
  const summaries = new Map(overview.data?.batches.map((s) => [s.batch_id, s]))
  const keepMonth = monthParam && month !== now ? month : undefined

  const addStudent = (batchId: number | null) => setNewStudent({ open: true, batchId })

  const loading = !students.data || !batches.data
  const error = students.error ?? batches.error

  return (
    <>
      <PageHeader
        title="Students"
        description="Everyone in your classes, by batch. Click a name to see their full history."
        actions={
          <Button variant="outline" size="lg" onClick={() => addStudent(null)}>
            <UserPlusIcon aria-hidden />
            New student
          </Button>
        }
      />

      {error && loading ? (
        <ErrorState
          error={error}
          onRetry={() => {
            void students.refetch()
            void batches.refetch()
          }}
        />
      ) : loading ? (
        <>
          <Skeleton className="mb-6 h-11 w-full" />
          <ListSkeleton rows={8} />
        </>
      ) : (
        <>
          <BatchNav
            batches={list}
            active={tab}
            allCount={all.filter((s) => s.is_active).length}
            noBatchCount={all.filter((s) => s.is_active && s.batch_id === null).length}
            month={keepMonth}
          />
          {tab === 'all' ? (
            <AllBatches
              batches={list}
              summaries={summaries}
              noBatch={overview.data?.no_batch}
              noBatchCount={all.filter((s) => s.is_active && s.batch_id === null).length}
              month={month}
              now={now}
              onMonth={setMonth}
              keepMonth={keepMonth}
              onNewBatch={() => setBatchForm({ open: true })}
              onEdit={(b) => setBatchForm({ open: true, batch: b })}
              onDelete={setDeleting}
            >
              <Panel title="All students" count={all.filter((s) => s.is_active).length}>
                <StudentsTable
                  students={all}
                  batches={list}
                  autoFocusSearch
                  emptyText="No students yet."
                  emptyAction={
                    <Button size="lg" onClick={() => addStudent(null)}>
                      <UserPlusIcon aria-hidden />
                      New student
                    </Button>
                  }
                />
              </Panel>
            </AllBatches>
          ) : tab === 'none' ? (
            <BatchView
              name="No batch"
              details={
                <p className="text-base text-muted-foreground">
                  Students who aren’t in a batch yet. Pick one in their Edit form.
                </p>
              }
              summary={overview.data?.no_batch}
              month={month}
              now={now}
              onMonth={setMonth}
              actions={
                <Button size="lg" onClick={() => addStudent(null)}>
                  <PlusIcon aria-hidden />
                  Add student
                </Button>
              }
            >
              <StudentsTable
                students={all}
                batches={list}
                inBatch="none"
                emptyText="Everyone is in a batch."
              />
            </BatchView>
          ) : (
            <OneBatch
              batch={list.find((b) => b.id === tab)}
              summary={typeof tab === 'number' ? summaries.get(tab) : undefined}
              month={month}
              now={now}
              onMonth={setMonth}
              onEdit={(b) => setBatchForm({ open: true, batch: b })}
              onDelete={setDeleting}
              onAddStudent={(b) => addStudent(b.id)}
            >
              {typeof tab === 'number' && (
                <StudentsTable
                  students={all}
                  batches={list}
                  inBatch={tab}
                  emptyText="No students in this batch yet."
                  emptyAction={
                    <Button size="lg" onClick={() => addStudent(tab)}>
                      <PlusIcon aria-hidden />
                      Add student
                    </Button>
                  }
                />
              )}
            </OneBatch>
          )}
        </>
      )}

      <StudentFormDialog
        open={newStudent.open}
        onOpenChange={(open) => setNewStudent((s) => ({ ...s, open }))}
        batchId={newStudent.batchId}
      />
      <BatchFormDialog
        open={batchForm.open}
        onOpenChange={(open) => setBatchForm((s) => ({ ...s, open }))}
        batch={batchForm.batch}
        onSaved={(saved) => {
          if (!batchForm.batch) void navigate(batchPath(saved.id, keepMonth))
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={deleting ? `Delete ${deleting.name}?` : ''}
        description={
          deleting && (
            <>
              <p>
                {deleting.student_count === 0
                  ? 'No students are in it.'
                  : `Its ${plural(deleting.student_count, 'student')} ${deleting.student_count === 1 ? 'isn’t' : 'aren’t'} deleted: ${deleting.student_count === 1 ? 'they move' : 'they all move'} to No batch.`}
              </p>
              <p>No fee or payment changes.</p>
            </>
          )
        }
        confirmLabel="Delete batch"
        onConfirm={async () => {
          if (!deleting) return
          const gone = deleting
          await deleteBatch.mutateAsync(gone.id)
          toast.success(`${gone.name} deleted`, {
            description:
              gone.student_count > 0
                ? `${plural(gone.student_count, 'student')} moved to No batch.`
                : undefined,
          })
          if (tab === gone.id) void navigate(batchPath(null, keepMonth))
        }}
      />
    </>
  )
}

// ---- All batches --------------------------------------------------------------------------------

function AllBatches({
  batches,
  summaries,
  noBatch,
  noBatchCount,
  month,
  now,
  onMonth,
  keepMonth,
  onNewBatch,
  onEdit,
  onDelete,
  children,
}: {
  batches: BatchRead[]
  summaries: Map<number | null, BatchSummary>
  noBatch: BatchSummary | undefined
  noBatchCount: number
  month: string | undefined
  now: string | undefined
  onMonth: (m: string) => void
  keepMonth: string | undefined
  onNewBatch: () => void
  onEdit: (b: BatchRead) => void
  onDelete: (b: BatchRead) => void
  children: ReactNode
}) {
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? batches : batches.slice(0, CARDS_SHOWN)
  return (
    <>
      <section aria-labelledby="batches-heading" className="mb-8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h2 id="batches-heading" className="flex items-center gap-2.5 text-xl font-extrabold">
              Batches
              <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-muted px-2 text-sm font-bold text-muted-foreground tabular-nums">
                {batches.length}
              </span>
            </h2>
            {month && batches.length > 0 && <MonthNav month={month} now={now} onChange={onMonth} />}
          </div>
          <div className="flex flex-wrap gap-2">
            <ConvertLabelsButton />
            <Button onClick={onNewBatch}>
              <PlusIcon aria-hidden />
              New batch
            </Button>
          </div>
        </div>

        {batches.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card/60">
            <EmptyState
              icon={<UsersIcon className="size-10 text-primary-strong" aria-hidden />}
              title="No batches yet."
              action={
                <Button size="lg" onClick={onNewBatch}>
                  <PlusIcon aria-hidden />
                  New batch
                </Button>
              }
            >
              A batch is a class your students come to, like “Mon/Wed Evening” at one place. Add
              one, then put students in it, to see each batch’s fees at a glance.
            </EmptyState>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((b) => (
                <BatchCard
                  key={b.id}
                  batch={b}
                  summary={summaries.get(b.id)}
                  month={keepMonth}
                  onEdit={() => onEdit(b)}
                  onDelete={() => onDelete(b)}
                />
              ))}
              {(showAll || batches.length <= CARDS_SHOWN) && noBatchCount > 0 && (
                <NoBatchCard count={noBatchCount} summary={noBatch} month={keepMonth} />
              )}
            </div>
            {batches.length > CARDS_SHOWN && (
              <div className="mt-3 flex justify-center">
                <Button variant="ghost" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? 'Show fewer batches' : `Show all ${batches.length} batches`}
                </Button>
              </div>
            )}
          </>
        )}
      </section>
      {children}
    </>
  )
}

// ---- One batch ----------------------------------------------------------------------------------

function OneBatch({
  batch,
  summary,
  month,
  now,
  onMonth,
  onEdit,
  onDelete,
  onAddStudent,
  children,
}: {
  batch: BatchRead | undefined
  summary: BatchSummary | undefined
  month: string | undefined
  now: string | undefined
  onMonth: (m: string) => void
  onEdit: (b: BatchRead) => void
  onDelete: (b: BatchRead) => void
  onAddStudent: (b: BatchRead) => void
  children: ReactNode
}) {
  if (!batch) {
    return (
      <Panel>
        <EmptyState
          title="This batch doesn’t exist any more."
          action={
            <Button variant="outline" asChild>
              <Link to="/students">Back to all batches</Link>
            </Button>
          }
        >
          It may have been deleted. Its students are under No batch.
        </EmptyState>
      </Panel>
    )
  }
  const schedule = formatSchedule(batch)
  return (
    <BatchView
      name={batch.name}
      details={
        <p className="text-base text-muted-foreground">
          {[
            batch.location,
            schedule,
            batch.default_fee_paise !== null
              ? `Usual fee ${formatRupees(batch.default_fee_paise)}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ') || 'No place, days or fee set yet. Add them with Edit batch.'}
          {batch.notes && <span className="block whitespace-pre-line">{batch.notes}</span>}
        </p>
      }
      summary={summary}
      month={month}
      now={now}
      onMonth={onMonth}
      actions={
        <>
          <Button variant="outline" size="lg" onClick={() => onEdit(batch)}>
            <PencilIcon aria-hidden />
            Edit batch
          </Button>
          <Button
            variant="ghost"
            size="icon-lg"
            onClick={() => onDelete(batch)}
            aria-label={`Delete ${batch.name}`}
            className="hover:bg-owed-soft hover:text-owed"
          >
            <Trash2Icon className="size-5" />
          </Button>
          <Button size="lg" onClick={() => onAddStudent(batch)} className="font-bold">
            <PlusIcon aria-hidden />
            Add student
          </Button>
        </>
      }
    >
      {children}
    </BatchView>
  )
}

/** A batch's (or "No batch"'s) header with the month's numbers, then its students. */
function BatchView({
  name,
  details,
  summary,
  month,
  now,
  onMonth,
  actions,
  children,
}: {
  name: string
  details: ReactNode
  summary: BatchSummary | undefined
  month: string | undefined
  now: string | undefined
  onMonth: (m: string) => void
  actions: ReactNode
  children: ReactNode
}) {
  const ahead = month !== undefined && now !== undefined && month > now
  return (
    <>
      <section
        aria-labelledby="batch-heading"
        className="mb-8 rounded-2xl border border-border/80 bg-card p-6 shadow-soft"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <h2
              id="batch-heading"
              className="text-2xl font-extrabold tracking-tight wrap-break-word"
            >
              {name}
            </h2>
            {details}
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </div>

        <div className="mt-5 border-t border-border/70 pt-4">
          {month && <MonthNav month={month} now={now} onChange={onMonth} />}
          {summary ? (
            <>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
                <Stat label="Students">{summary.student_count}</Stat>
                <Stat label={month ? `Fees for ${formatMonth(month)}` : 'Fees this month'}>
                  {formatRupees(summary.expected_paise)}
                </Stat>
                <Stat label={ahead ? 'Paid ahead' : 'Collected'}>
                  {formatRupees(summary.collected_paise)}
                </Stat>
                <Stat label="Still to pay" tone={summary.still_due_paise > 0 ? 'owed' : 'paid'}>
                  {formatRupees(summary.still_due_paise)}
                  {summary.not_fully_paid_count > 0 && (
                    <span className="block text-sm font-semibold text-muted-foreground">
                      {plural(summary.not_fully_paid_count, 'student')}
                    </span>
                  )}
                </Stat>
              </dl>
              <PaidBar summary={summary} size="lg" className="mt-4" />
            </>
          ) : (
            <Skeleton className="mt-3 h-20 w-full" />
          )}
        </div>
      </section>

      <Panel title="Students in this batch">{children}</Panel>
    </>
  )
}

function Stat({
  label,
  tone,
  children,
}: {
  label: string
  tone?: 'owed' | 'paid'
  children: ReactNode
}) {
  return (
    <div>
      <dt className="text-sm font-semibold text-muted-foreground">{label}</dt>
      <dd
        className={
          'text-xl font-extrabold tabular-nums ' +
          (tone === 'owed' ? 'text-owed' : tone === 'paid' ? 'text-paid' : '')
        }
      >
        {children}
      </dd>
    </div>
  )
}
