/**
 * Every student (or one batch's), to find anyone fast: type to search (it filters as you type;
 * Enter opens the first match; "/" jumps to the search box), sort by any column, filter by batch,
 * location, day, status and Active / Left, and group under headings. A click anywhere on a row
 * opens the profile.
 *
 * Search looks at everyone the Active / Left choice shows, then the other filters: if they hide
 * someone who matches, it says so, with one click to show them.
 */
import { ArrowDownIcon, ArrowUpIcon, SearchIcon, XIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'

import type { BatchRead, StudentRead } from '@/api/types'
import { FeeNow } from '@/components/fee-now'
import { EmptyState } from '@/components/states'
import { BalanceChip, PaidAheadNote } from '@/components/status'
import { StudentAvatar } from '@/components/student-avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  batchPath,
  formatSchedule,
  groupStudents,
  locationsOf,
  matchesFilters,
  NO_FILTERS,
  sortStudents,
  WEEKDAYS,
  type GroupBy,
  type ShowFilter,
  type SortDir,
  type SortKey,
  type StatusFilter,
  type TableFilters,
} from '@/lib/batches'
import { formatMonthShort } from '@/lib/format'
import { plural, tenureLabel } from '@/lib/labels'
import { studentMatches } from '@/lib/search'
import { cn } from '@/lib/utils'

const SORTS: { value: SortKey; label: string; dir: SortDir }[] = [
  { value: 'name', label: 'Name', dir: 'asc' },
  { value: 'batch', label: 'Batch', dir: 'asc' },
  { value: 'fee', label: 'Monthly fee', dir: 'desc' },
  { value: 'status', label: 'Status', dir: 'asc' },
  { value: 'owes', label: 'Owes most', dir: 'desc' },
  { value: 'tenure', label: 'Member for', dir: 'desc' },
]

const GROUPS: { value: GroupBy; label: string }[] = [
  { value: 'none', label: 'No groups' },
  { value: 'batch', label: 'Batch' },
  { value: 'location', label: 'Location' },
  { value: 'day', label: 'Day' },
  { value: 'status', label: 'Status' },
]

export function StudentsTable({
  students,
  batches,
  inBatch,
  initialGroup = 'none',
  autoFocusSearch = false,
  emptyAction,
  emptyText,
}: {
  students: readonly StudentRead[]
  batches: readonly BatchRead[]
  /** On a batch's tab: only its students, without the batch column and batch filters. */
  inBatch?: number | 'none'
  initialGroup?: GroupBy
  autoFocusSearch?: boolean
  emptyAction?: ReactNode
  emptyText?: ReactNode
}) {
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'name', dir: 'asc' })
  const [filters, setFilters] = useState<TableFilters>(NO_FILTERS)
  const [group, setGroup] = useState<GroupBy>(initialGroup)
  const searchRef = useRef<HTMLInputElement>(null)

  const byId = useMemo(() => new Map(batches.map((b) => [b.id, b])), [batches])
  const own = useMemo(
    () =>
      inBatch === undefined
        ? students
        : students.filter((s) =>
            inBatch === 'none' ? s.batch_id === null : s.batch_id === inBatch,
          ),
    [students, inBatch],
  )
  const needle = search.trim()
  const matching = own.filter((s) => studentMatches(s, needle))
  const shown = sortStudents(
    matching.filter((s) => matchesFilters(s, filters, byId)),
    sort.key,
    sort.dir,
    byId,
  )
  const hidden = needle ? matching.length - shown.length : 0
  const groups = groupStudents(shown, group, byId)
  const filtered = JSON.stringify(filters) !== JSON.stringify(NO_FILTERS)
  const counts = {
    active: own.filter((s) => s.is_active).length,
    left: own.filter((s) => !s.is_active).length,
    all: own.length,
  }

  // On a wide window the search box is ready to type in straight away (without scrolling to
  // it). Not on a narrow one, where it would pop up a keyboard and hide the batches.
  useEffect(() => {
    if (autoFocusSearch && window.matchMedia?.('(min-width: 1024px)').matches) {
      searchRef.current?.focus({ preventScroll: true })
    }
  }, [autoFocusSearch])

  // "/" anywhere on the page (outside a box you're typing in) jumps to the search.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey) {
        event.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    // The first row; if the filters hide everyone who matches, the first match anyway (someone
    // who has left, say), so Enter always finds who was typed.
    const first = shown[0] ?? sortStudents(matching, sort.key, sort.dir, byId)[0]
    if (event.key === 'Enter' && needle && first) {
      event.preventDefault()
      void navigate(`/students/${first.id}`)
    } else if (event.key === 'Escape' && search) {
      event.preventDefault()
      setSearch('')
    }
  }

  const sortBy = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: SORTS.find((x) => x.value === key)!.dir },
    )
  const set = <K extends keyof TableFilters>(key: K, value: TableFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }))

  const showBatch = inBatch === undefined
  const columns = showBatch ? 5 : 4
  const places = locationsOf(batches)

  return (
    <>
      <div className="grid gap-3 border-b border-border/70 px-6 py-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full lg:max-w-sm lg:min-w-72 lg:flex-1">
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={onSearchKey}
              placeholder={
                showBatch ? 'Search name, phone, parent or batch' : 'Search name, phone or parent'
              }
              aria-label="Search students"
              aria-describedby="students-search-help"
              className="h-12 pl-10 text-base"
            />
            <kbd
              className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded border border-border bg-muted px-1.5 text-xs text-muted-foreground md:block"
              aria-hidden
            >
              /
            </kbd>
          </div>
          <FilterSelect
            label="Show"
            value={filters.show}
            onChange={(v) => set('show', v as ShowFilter)}
            options={[
              { value: 'active', label: `Active (${counts.active})` },
              { value: 'left', label: `Left (${counts.left})` },
              { value: 'all', label: `Everyone (${counts.all})` },
            ]}
          />
          <FilterSelect
            label="Sort by"
            value={sort.key}
            onChange={(v) =>
              setSort({ key: v as SortKey, dir: SORTS.find((x) => x.value === v)!.dir })
            }
            options={SORTS}
          />
          <FilterSelect
            label="Group by"
            value={group}
            onChange={(v) => setGroup(v as GroupBy)}
            options={
              showBatch ? GROUPS : GROUPS.filter((g) => g.value === 'none' || g.value === 'status')
            }
          />
          {showBatch && (
            <FilterSelect
              label="Batch"
              value={String(filters.batch)}
              onChange={(v) => set('batch', v === 'all' || v === 'none' ? v : Number(v))}
              options={[
                { value: 'all', label: 'All batches' },
                ...batches.map((b) => ({ value: String(b.id), label: b.name })),
                { value: 'none', label: 'No batch' },
              ]}
            />
          )}
          {showBatch && places.length > 0 && (
            <FilterSelect
              label="Location"
              value={filters.location}
              onChange={(v) => set('location', v)}
              options={[
                { value: 'all', label: 'All locations' },
                ...places.map((p) => ({ value: p, label: p })),
                { value: 'none', label: 'No location' },
              ]}
            />
          )}
          {showBatch && (
            <FilterSelect
              label="Day"
              value={filters.day}
              onChange={(v) => set('day', v as TableFilters['day'])}
              options={[
                { value: 'all', label: 'Any day' },
                ...WEEKDAYS.map((d) => ({ value: d.value, label: d.long })),
              ]}
            />
          )}
          <FilterSelect
            label="Status"
            value={filters.status}
            onChange={(v) => set('status', v as StatusFilter)}
            options={[
              { value: 'all', label: 'Any status' },
              { value: 'owes', label: 'Owes' },
              { value: 'up_to_date', label: 'Up to date' },
              { value: 'credit', label: 'Has credit' },
            ]}
          />
          {filtered && (
            <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
              <XIcon aria-hidden />
              Clear filters
            </Button>
          )}
        </div>
        <p id="students-search-help" className="sr-only">
          Filters as you type. Press Enter to open the first student.
        </p>
      </div>

      {hidden > 0 && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 bg-primary/10 px-6 py-3 text-base"
        >
          {plural(hidden, 'more student')} {hidden === 1 ? 'matches' : 'match'} “{needle}” but{' '}
          {hidden === 1 ? 'is' : 'are'} hidden by the filters.
          <Button
            variant="link"
            className="h-auto p-0 text-base font-bold"
            onClick={() => setFilters({ ...NO_FILTERS, show: 'all' })}
          >
            Show {hidden === 1 ? 'them' : 'them all'}
          </Button>
        </p>
      )}

      {own.length === 0 ? (
        <EmptyState
          className="py-12"
          title={emptyText ?? 'No students here yet.'}
          action={emptyAction}
        />
      ) : shown.length === 0 ? (
        <EmptyState
          className="py-12"
          title={
            needle
              ? `No students match “${needle}”.`
              : filters.show === 'left' && !filtered
                ? 'No one has left.'
                : 'No students match these filters.'
          }
          action={
            (filtered || needle) && (
              <Button
                variant="outline"
                onClick={() => {
                  setFilters(NO_FILTERS)
                  setSearch('')
                }}
              >
                Clear search and filters
              </Button>
            )
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <Table className={showBatch ? 'min-w-[54rem]' : 'min-w-[44rem]'}>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortHead className="pl-6" label="Name" col="name" sort={sort} onSort={sortBy} />
                {showBatch && <SortHead label="Batch" col="batch" sort={sort} onSort={sortBy} />}
                <SortHead
                  className="text-right"
                  label="Monthly fee"
                  col="fee"
                  sort={sort}
                  onSort={sortBy}
                />
                <SortHead
                  label="Status"
                  col={sort.key === 'owes' ? 'owes' : 'status'}
                  sort={sort}
                  onSort={sortBy}
                />
                <SortHead
                  className="pr-6"
                  label="Member for"
                  col="tenure"
                  sort={sort}
                  onSort={sortBy}
                />
              </TableRow>
            </TableHeader>
            {groups.map((g) => (
              <TableBody key={g.key}>
                {group !== 'none' && (
                  <TableRow className="bg-muted/50 hover:bg-muted/50">
                    <TableCell colSpan={columns} className="px-6 py-2.5">
                      <div className="flex flex-wrap items-baseline gap-x-3">
                        <h3 className="text-base font-extrabold">
                          {g.to ? (
                            <Link
                              to={g.to}
                              className="rounded outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                            >
                              {g.label}
                            </Link>
                          ) : (
                            g.label
                          )}
                        </h3>
                        <span className="text-sm text-muted-foreground tabular-nums">
                          {plural(g.students.length, 'student')}
                          {g.detail && ` · ${g.detail}`}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {g.students.map((s) => (
                  <StudentRow
                    key={`${g.key}-${s.id}`}
                    student={s}
                    batch={s.batch_id === null ? undefined : byId.get(s.batch_id)}
                    showBatch={showBatch}
                  />
                ))}
              </TableBody>
            ))}
          </Table>
        </div>
      )}
    </>
  )
}

function StudentRow({
  student: s,
  batch,
  showBatch,
}: {
  student: StudentRead
  batch: BatchRead | undefined
  showBatch: boolean
}) {
  const navigate = useNavigate()
  const schedule = batch ? formatSchedule(batch) : ''
  return (
    <TableRow className="cursor-pointer" onClick={() => void navigate(`/students/${s.id}`)}>
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
      {showBatch && (
        <TableCell className="max-w-64 whitespace-normal">
          {batch ? (
            <>
              <Link
                to={batchPath(batch.id)}
                onClick={(e) => e.stopPropagation()}
                className="line-clamp-2 rounded font-semibold wrap-break-word outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {batch.name}
              </Link>
              {schedule && <p className="text-sm text-muted-foreground">{schedule}</p>}
            </>
          ) : (
            <span className="text-muted-foreground">No batch</span>
          )}
        </TableCell>
      )}
      <TableCell className="text-right font-semibold tabular-nums">
        <FeeNow student={s} />
      </TableCell>
      <TableCell>
        <div className="flex flex-col items-start gap-1">
          <BalanceChip student={s} />
          {s.paid_ahead_paise > 0 && <PaidAheadNote paise={s.paid_ahead_paise} />}
        </div>
      </TableCell>
      <TableCell className="pr-6">
        {!s.is_active && s.left_month ? (
          <span className="text-muted-foreground">Left {formatMonthShort(s.left_month)}</span>
        ) : (
          <>
            {tenureLabel(s)}
            {s.tenure_months > 0 && !s.left_month && (
              <span className="block text-sm text-muted-foreground">
                Since {formatMonthShort(s.joined_month)}
              </span>
            )}
            {s.left_month && (
              <span className="block text-sm text-muted-foreground">
                Leaving after {formatMonthShort(s.left_month)}
              </span>
            )}
          </>
        )}
      </TableCell>
    </TableRow>
  )
}

function SortHead({
  label,
  col,
  sort,
  onSort,
  className,
}: {
  label: string
  col: SortKey
  sort: { key: SortKey; dir: SortDir }
  onSort: (key: SortKey) => void
  className?: string
}) {
  const active = sort.key === col
  const Icon = sort.dir === 'asc' ? ArrowUpIcon : ArrowDownIcon
  return (
    <TableHead
      className={className}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          '-mx-1 inline-flex items-center gap-1 rounded px-1 font-bold outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50',
          active && 'text-foreground',
        )}
      >
        {label}
        {active && <Icon className="size-4" aria-hidden />}
      </button>
    </TableHead>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}) {
  const current = options.find((o) => o.value === value)
  const isDefault = options[0]?.value === value
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={`${label}: ${current?.label ?? value}`}
        className={cn(
          'h-10 max-w-64 min-w-0 bg-card text-base',
          !isDefault && 'border-primary bg-primary/10 font-bold',
        )}
      >
        <span className="shrink-0 text-muted-foreground">{label}:</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-[50vh]">
        <SelectGroup>
          <SelectLabel>{label}</SelectLabel>
          {options.map((o, i) => (
            <FilterOption
              key={o.value}
              value={o.value}
              label={o.label}
              separator={i === 0 && options.length > 3}
            />
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

function FilterOption({
  value,
  label,
  separator,
}: {
  value: string
  label: string
  separator: boolean
}) {
  return (
    <>
      <SelectItem value={value}>
        <span className="truncate">{label}</span>
      </SelectItem>
      {separator && <SelectSeparator />}
    </>
  )
}
