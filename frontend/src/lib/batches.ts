/**
 * Batches in words ("Mon, Wed · 5:00–6:00 pm"), their links, and the sorting, filtering and
 * grouping of the Students page's table.
 */
import type { BatchRead, LabelPreview, StudentRead, Weekday } from '@/api/types'
import { plural } from '@/lib/labels'
import { fold } from '@/lib/search'

export const WEEKDAYS: { value: Weekday; short: string; long: string }[] = [
  { value: 'mon', short: 'Mon', long: 'Monday' },
  { value: 'tue', short: 'Tue', long: 'Tuesday' },
  { value: 'wed', short: 'Wed', long: 'Wednesday' },
  { value: 'thu', short: 'Thu', long: 'Thursday' },
  { value: 'fri', short: 'Fri', long: 'Friday' },
  { value: 'sat', short: 'Sat', long: 'Saturday' },
  { value: 'sun', short: 'Sun', long: 'Sunday' },
]

/** ["mon", "wed"] -> "Mon, Wed"; every weekday -> "Mon–Fri"; all seven -> "Every day". */
export function formatDays(days: readonly Weekday[]): string {
  const set = new Set(days)
  if (set.size === 7) return 'Every day'
  const weekdays: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri']
  if (set.size === 5 && weekdays.every((d) => set.has(d))) return 'Mon–Fri'
  return WEEKDAYS.filter((d) => set.has(d.value))
    .map((d) => d.short)
    .join(', ')
}

function parts(time: string): { h: number; m: number } {
  const [h = '0', m = '0'] = time.split(':')
  return { h: Number(h), m: Number(m) }
}

const suffix = (h: number) => (h < 12 ? 'am' : 'pm')

function clock(time: string): string {
  const { h, m } = parts(time)
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')}`
}

/** "17:00" -> "5:00 pm", "09:30" -> "9:30 am", "12:00" -> "12:00 pm". */
export function formatTime(time: string): string {
  return `${clock(time)} ${suffix(parts(time).h)}`
}

/** "5:00–6:00 pm", "11:00 am–12:30 pm", "from 5:00 pm", "until 6:00 pm", or "". */
export function formatTimes(start: string | null, end: string | null): string {
  if (start && end) {
    const same = suffix(parts(start).h) === suffix(parts(end).h)
    return same ? `${clock(start)}–${formatTime(end)}` : `${formatTime(start)}–${formatTime(end)}`
  }
  if (start) return `from ${formatTime(start)}`
  if (end) return `until ${formatTime(end)}`
  return ''
}

type Schedule = Pick<BatchRead, 'days' | 'start_time' | 'end_time'>

/** "Mon, Wed · 5:00–6:00 pm", or only what's set ("Sat", "5:00–6:00 pm"), or "". */
export function formatSchedule(batch: Schedule): string {
  return [formatDays(batch.days), formatTimes(batch.start_time, batch.end_time)]
    .filter(Boolean)
    .join(' · ')
}

/** The Students page's tab for a batch; `'none'` for the students in no batch. */
export function batchPath(id: number | 'none' | null | undefined, month?: string): string {
  const base = id === null || id === undefined ? '/students' : `/students/batch/${id}`
  return month ? `${base}?month=${month}` : base
}

/** Case-, accent- and space-insensitive, as the server compares batch names and locations. */
export function sameText(a: string, b: string): boolean {
  return textKey(a) === textKey(b)
}

export function textKey(text: string): string {
  return fold(text).replace(/\s+/g, '')
}

/** Every location in use, once each (the first spelling), sorted. */
export function locationsOf(batches: readonly BatchRead[]): string[] {
  const seen = new Map<string, string>()
  for (const b of batches) {
    const where = b.location?.trim()
    if (where && !seen.has(textKey(where))) seen.set(textKey(where), where)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
}

// ---- The students table ----------------------------------------------------------------------

export type SortKey = 'name' | 'batch' | 'fee' | 'status' | 'owes' | 'tenure'
export type SortDir = 'asc' | 'desc'
export type GroupBy = 'none' | 'batch' | 'location' | 'day' | 'status'
export type StatusFilter = 'all' | 'owes' | 'up_to_date' | 'credit'
export type ShowFilter = 'active' | 'left' | 'all'

export interface TableFilters {
  /** A batch id, `'none'` for no batch, or `'all'`. */
  batch: number | 'none' | 'all'
  /** A location (any spelling), `'none'` for no location, or `'all'`. */
  location: string
  /** A weekday, or `'all'`. */
  day: Weekday | 'all'
  status: StatusFilter
  show: ShowFilter
}

export const NO_FILTERS: TableFilters = {
  batch: 'all',
  location: 'all',
  day: 'all',
  status: 'all',
  show: 'active',
}

type BatchesById = ReadonlyMap<number, BatchRead>

const STATUS_ORDER: Record<StudentRead['status'], number> = { owes: 0, credit: 1, up_to_date: 2 }

export const STATUS_LABELS: Record<StudentRead['status'], string> = {
  owes: 'Owes',
  up_to_date: 'Up to date',
  credit: 'Has credit',
}

export function matchesFilters(
  student: StudentRead,
  filters: TableFilters,
  batches: BatchesById,
): boolean {
  const batch = student.batch_id === null ? undefined : batches.get(student.batch_id)
  if (filters.show !== 'all' && student.is_active !== (filters.show === 'active')) return false
  if (filters.batch === 'none' && student.batch_id !== null) return false
  if (typeof filters.batch === 'number' && student.batch_id !== filters.batch) return false
  if (filters.location === 'none' && batch?.location) return false
  if (
    filters.location !== 'all' &&
    filters.location !== 'none' &&
    !(batch?.location && sameText(batch.location, filters.location))
  )
    return false
  if (filters.day !== 'all' && !batch?.days.includes(filters.day)) return false
  if (filters.status !== 'all' && student.status !== filters.status) return false
  return true
}

const byText = (a: string, b: string) =>
  a.localeCompare(b, 'en', { sensitivity: 'base', numeric: true })

/** Sorted by `key`; ties by name. Students in no batch go last when sorting by batch. */
export function sortStudents(
  students: readonly StudentRead[],
  key: SortKey,
  dir: SortDir,
  batches: BatchesById,
): StudentRead[] {
  const sign = dir === 'asc' ? 1 : -1
  const batchName = (s: StudentRead) =>
    (s.batch_id !== null && batches.get(s.batch_id)?.name) || s.batch_name || null
  const compare = (a: StudentRead, b: StudentRead): number => {
    switch (key) {
      case 'name':
        return 0
      case 'batch': {
        const x = batchName(a)
        const y = batchName(b)
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
        return sign * byText(x, y)
      }
      case 'fee':
        return sign * (a.monthly_fee_paise - b.monthly_fee_paise)
      case 'status':
        return sign * (STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
      case 'owes':
        return sign * (a.owed_paise - b.owed_paise)
      case 'tenure':
        return sign * (a.tenure_months - b.tenure_months)
    }
  }
  const nameSign = key === 'name' ? sign : 1
  return students.toSorted(
    (a, b) => compare(a, b) || nameSign * byText(a.name, b.name) || a.id - b.id,
  )
}

export interface StudentGroup {
  key: string
  label: string
  /** A second line for the group heading (a batch's schedule and place). */
  detail?: string
  /** Where the heading links to (a batch's tab). */
  to?: string
  students: StudentRead[]
}

/**
 * The rows under headings. Groups come in a sensible order (batches by name, days Monday first,
 * statuses Owes first), with "No batch" / "No location" / "No day set" last. Grouping by day
 * lists a student under each day their batch meets. The students keep their order.
 */
export function groupStudents(
  students: readonly StudentRead[],
  by: GroupBy,
  batches: BatchesById,
): StudentGroup[] {
  if (by === 'none') return [{ key: 'all', label: 'All', students: [...students] }]
  const groups = new Map<string, StudentGroup & { order: string }>()
  const add = (
    key: string,
    order: string,
    make: () => Omit<StudentGroup, 'students' | 'key'>,
    s: StudentRead,
  ) => {
    let group = groups.get(key)
    if (!group) {
      group = { ...make(), key, order, students: [] }
      groups.set(key, group)
    }
    group.students.push(s)
  }
  const LAST = '￿'
  for (const s of students) {
    const batch = s.batch_id === null ? undefined : batches.get(s.batch_id)
    if (by === 'batch') {
      if (batch) {
        add(
          `b${batch.id}`,
          String([...batches.keys()].indexOf(batch.id)).padStart(6, '0'),
          () => ({
            label: batch.name,
            detail:
              [formatSchedule(batch), batch.location].filter(Boolean).join(' · ') || undefined,
            to: batchPath(batch.id),
          }),
          s,
        )
      } else add('none', LAST, () => ({ label: 'No batch', to: batchPath('none') }), s)
    } else if (by === 'location') {
      const where = batch?.location?.trim()
      if (where) add(`l${textKey(where)}`, fold(where), () => ({ label: where }), s)
      else add('none', LAST, () => ({ label: 'No location' }), s)
    } else if (by === 'day') {
      const days = batch?.days ?? []
      if (days.length === 0) add('none', LAST, () => ({ label: 'No day set' }), s)
      for (const d of days) {
        const i = WEEKDAYS.findIndex((w) => w.value === d)
        add(d, String(i), () => ({ label: WEEKDAYS[i]!.long }), s)
      }
    } else {
      add(s.status, String(STATUS_ORDER[s.status]), () => ({ label: STATUS_LABELS[s.status] }), s)
    }
  }
  return [...groups.values()]
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    .map(({ order: _order, ...group }) => group)
}

// ---- Forms --------------------------------------------------------------------------------------

/** Every word typed appears in the batch's name, location, days or times. */
export function batchMatches(batch: BatchRead, typed: string): boolean {
  const words = fold(typed).split(/\s+/).filter(Boolean)
  const text = fold([batch.name, batch.location, formatSchedule(batch)].filter(Boolean).join(' '))
  return words.every((w) => text.includes(w))
}

/** "5 batches from 42 students" (or "into 2 batches you already have"). */
export function previewSentence(preview: LabelPreview): string {
  const existing = preview.groups.length - preview.new_batch_count
  const parts: string[] = []
  if (preview.new_batch_count > 0)
    parts.push(plural(preview.new_batch_count, 'new batch', 'new batches'))
  if (existing > 0) parts.push(`${plural(existing, 'batch', 'batches')} you already have`)
  return `${parts.join(' and ')} from ${plural(preview.student_count, 'student')}`
}
