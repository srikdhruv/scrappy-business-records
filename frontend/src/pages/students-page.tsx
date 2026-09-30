/**
 * Every student (PRD scope 6) with their status and how long they've been coming. Search and
 * the Active / Left / All tabs filter on the spot; click a row to open the profile.
 */
import { SearchIcon, UserPlusIcon, UsersIcon } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'

import { useStudents } from '@/api/queries'
import type { StudentRead } from '@/api/types'
import { PageHeader } from '@/components/layout/page-header'
import { Panel } from '@/components/panel'
import { EmptyState, ErrorState, ListSkeleton } from '@/components/states'
import { BalanceChip, ExtraPaidNote } from '@/components/status'
import { StudentAvatar } from '@/components/student-avatar'
import { StudentFormDialog } from '@/components/student-form'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatMonthShort, formatRupees } from '@/lib/format'
import { tenureLabel } from '@/lib/labels'

type Tab = 'active' | 'left' | 'all'
const TABS: { value: Tab; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'left', label: 'Left' },
  { value: 'all', label: 'All' },
]

function matches(student: StudentRead, needle: string): boolean {
  if (!needle) return true
  return [student.name, student.phone, student.guardian_name, student.batch_label].some((v) =>
    v?.toLowerCase().includes(needle),
  )
}

export function StudentsPage() {
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab') as Tab | null
  const tab: Tab = tabParam && TABS.some((t) => t.value === tabParam) ? tabParam : 'active'
  const [search, setSearch] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const navigate = useNavigate()
  const students = useStudents('all')

  const all = students.data ?? []
  const needle = search.trim().toLowerCase()
  const counts = {
    active: all.filter((s) => s.is_active).length,
    left: all.filter((s) => !s.is_active).length,
    all: all.length,
  }
  const shown = all.filter(
    (s) => (tab === 'all' || (tab === 'active' ? s.is_active : !s.is_active)) && matches(s, needle),
  )

  return (
    <>
      <PageHeader
        title="Students"
        description="Everyone in your classes. Click a name to see their full history."
        actions={
          <Button variant="outline" size="lg" onClick={() => setNewOpen(true)}>
            <UserPlusIcon aria-hidden />
            New student
          </Button>
        }
      />

      <Panel bodyClassName="pt-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-6 py-5">
          <Tabs
            value={tab}
            onValueChange={(v) => setParams(v === 'active' ? {} : { tab: v }, { replace: true })}
          >
            <TabsList aria-label="Which students to show">
              {TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value} className="gap-2">
                  {t.label}
                  <span className="rounded-full bg-muted px-2 text-sm tabular-nums">
                    {counts[t.value]}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="relative w-full sm:w-80">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, phone or parent"
              aria-label="Search students"
              className="pl-10"
            />
          </div>
        </div>

        {students.error && !students.data ? (
          <div className="p-6">
            <ErrorState error={students.error} onRetry={() => void students.refetch()} />
          </div>
        ) : !students.data ? (
          <div className="p-6">
            <ListSkeleton rows={8} />
          </div>
        ) : all.length === 0 ? (
          <EmptyState
            className="py-14"
            icon={<UsersIcon className="size-10 text-primary-strong" aria-hidden />}
            title="No students yet."
            action={
              <Button size="lg" onClick={() => setNewOpen(true)}>
                <UserPlusIcon aria-hidden />
                New student
              </Button>
            }
          >
            Add your first student to start keeping track of fees.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState
            title={
              needle
                ? `No students match “${search.trim()}”.`
                : tab === 'left'
                  ? 'No one has left.'
                  : 'No active students.'
            }
          />
        ) : (
          <Table className="min-w-[46rem]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-6">Name</TableHead>
                <TableHead>Class or batch</TableHead>
                <TableHead className="text-right">Monthly fee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="pr-6">Member for</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((s) => (
                <TableRow
                  key={s.id}
                  className="cursor-pointer"
                  onClick={() => void navigate(`/students/${s.id}`)}
                >
                  <TableCell className="max-w-80 pl-6 whitespace-normal">
                    <div className="flex items-center gap-3">
                      <StudentAvatar name={s.name} />
                      <div className="min-w-0">
                        <Link
                          to={`/students/${s.id}`}
                          className="rounded font-bold wrap-break-word outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {s.name}
                        </Link>
                        {s.guardian_name && (
                          <p className="text-sm wrap-break-word text-muted-foreground">
                            Parent: {s.guardian_name}
                          </p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground">
                    {s.batch_label ?? '—'}
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">
                    {formatRupees(s.monthly_fee_paise)}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <BalanceChip
                        status={s.status}
                        balancePaise={s.balance_paise}
                        creditPaise={s.credit_paise}
                      />
                      {s.status !== 'credit' && s.credit_paise > 0 && (
                        <ExtraPaidNote paise={s.credit_paise} />
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="pr-6">
                    {!s.is_active && s.left_month ? (
                      <span className="text-muted-foreground">
                        Left {formatMonthShort(s.left_month)}
                      </span>
                    ) : (
                      <>
                        {tenureLabel(s)}
                        {s.left_month && (
                          <span className="block text-sm text-muted-foreground">
                            Leaving after {formatMonthShort(s.left_month)}
                          </span>
                        )}
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Panel>

      <StudentFormDialog open={newOpen} onOpenChange={setNewOpen} />
    </>
  )
}
