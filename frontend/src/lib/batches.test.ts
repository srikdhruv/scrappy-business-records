import type { BatchRead, LabelPreview, StudentRead } from '@/api/types'
import {
  batchMatches,
  batchPath,
  feeChangeFor,
  formatDays,
  formatSchedule,
  formatTime,
  formatTimes,
  groupStudents,
  locationsOf,
  matchesFilters,
  NO_FILTERS,
  previewSentence,
  sortStudents,
} from '@/lib/batches'

function batch(id: number, fields: Partial<BatchRead> = {}): BatchRead {
  return {
    id,
    name: `Batch ${id}`,
    location: null,
    days: [],
    start_time: null,
    end_time: null,
    default_fee_paise: null,
    notes: null,
    student_count: 0,
    active_student_count: 0,
    created_at: '',
    updated_at: '',
    ...fields,
  }
}

function student(id: number, fields: Partial<StudentRead> = {}): StudentRead {
  return {
    id,
    name: `Student ${id}`,
    phone: null,
    guardian_name: null,
    batch_label: null,
    batch_id: null,
    batch_name: null,
    joined_month: '2026-01',
    left_month: null,
    notes: null,
    is_active: true,
    monthly_fee_paise: 150000,
    balance_paise: 0,
    status: 'up_to_date',
    owed_paise: 0,
    paid_ahead_paise: 0,
    credit_paise: 0,
    next_fee_change: null,
    tenure_months: 3,
    current_month: '2026-10',
    created_at: '',
    updated_at: '',
    ...fields,
  }
}

describe('batch words', () => {
  it('says the days, Monday first', () => {
    expect(formatDays(['wed', 'mon'])).toBe('Mon, Wed')
    expect(formatDays(['sat'])).toBe('Sat')
    expect(formatDays(['mon', 'tue', 'wed', 'thu', 'fri'])).toBe('Mon–Fri')
    expect(formatDays(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).toBe('Every day')
    expect(formatDays([])).toBe('')
  })

  it('says times in 12-hour words', () => {
    expect(formatTime('17:00')).toBe('5:00 pm')
    expect(formatTime('09:30')).toBe('9:30 am')
    expect(formatTime('12:00')).toBe('12:00 pm')
    expect(formatTime('00:15')).toBe('12:15 am')
    expect(formatTimes('17:00', '18:00')).toBe('5:00–6:00 pm')
    expect(formatTimes('11:00', '12:30')).toBe('11:00 am–12:30 pm')
    expect(formatTimes('17:00', null)).toBe('from 5:00 pm')
    expect(formatTimes(null, '18:00')).toBe('until 6:00 pm')
    expect(formatTimes(null, null)).toBe('')
  })

  it('puts days and times together', () => {
    const b = batch(1, { days: ['mon', 'wed'], start_time: '17:00', end_time: '18:00' })
    expect(formatSchedule(b)).toBe('Mon, Wed · 5:00–6:00 pm')
    expect(formatSchedule(batch(2, { days: ['sat'] }))).toBe('Sat')
    expect(formatSchedule(batch(3))).toBe('')
  })

  it('links to a batch’s tab, keeping the month', () => {
    expect(batchPath(3)).toBe('/students/batch/3')
    expect(batchPath('none', '2026-08')).toBe('/students/batch/none?month=2026-08')
    expect(batchPath(null)).toBe('/students')
  })

  it('lists each location once, whatever the spelling', () => {
    const list = [
      batch(1, { location: 'Koramangala' }),
      batch(2, { location: 'koramangala ' }),
      batch(3, { location: 'HSR Layout' }),
      batch(4),
    ]
    expect(locationsOf(list)).toEqual(['HSR Layout', 'Koramangala'])
  })

  it('finds a batch by name, place or day', () => {
    const b = batch(1, { name: 'Evening', location: 'Koramangala', days: ['sat'] })
    expect(batchMatches(b, 'kora')).toBe(true)
    expect(batchMatches(b, 'sat eve')).toBe(true)
    expect(batchMatches(b, 'sun')).toBe(false)
  })
})

describe('the students table', () => {
  const kora = batch(1, { name: 'Mon/Wed', location: 'Koramangala', days: ['mon', 'wed'] })
  const hsr = batch(2, { name: 'Sat', location: 'HSR Layout', days: ['sat'] })
  const byId = new Map([
    [kora.id, kora],
    [hsr.id, hsr],
  ])
  const a = student(1, { name: 'Ananya', batch_id: 1, monthly_fee_paise: 150000 })
  const b = student(2, {
    name: 'Kabir',
    batch_id: 2,
    status: 'owes',
    owed_paise: 300000,
    monthly_fee_paise: 120000,
  })
  const c = student(3, { name: 'Diya', monthly_fee_paise: 200000, tenure_months: 9 })
  const d = student(4, { name: 'Rohan', batch_id: 1, is_active: false, left_month: '2026-05' })

  it('filters by batch, no batch, location, day, status and Active / Left', () => {
    const shown = (f: Partial<typeof NO_FILTERS>) =>
      [a, b, c, d].filter((s) => matchesFilters(s, { ...NO_FILTERS, ...f }, byId)).map((s) => s.id)
    expect(shown({})).toEqual([1, 2, 3])
    expect(shown({ show: 'left' })).toEqual([4])
    expect(shown({ show: 'all', batch: 1 })).toEqual([1, 4])
    expect(shown({ batch: 'none' })).toEqual([3])
    expect(shown({ location: 'koramangala' })).toEqual([1])
    expect(shown({ location: 'none' })).toEqual([3])
    expect(shown({ day: 'sat' })).toEqual([2])
    expect(shown({ status: 'owes' })).toEqual([2])
  })

  it('sorts by any column, ties by name, no batch last', () => {
    const ids = (key: Parameters<typeof sortStudents>[1], dir: 'asc' | 'desc' = 'asc') =>
      sortStudents([a, b, c], key, dir, byId).map((s) => s.name)
    expect(ids('name')).toEqual(['Ananya', 'Diya', 'Kabir'])
    expect(ids('name', 'desc')).toEqual(['Kabir', 'Diya', 'Ananya'])
    expect(ids('batch')).toEqual(['Ananya', 'Kabir', 'Diya'])
    expect(ids('batch', 'desc')).toEqual(['Kabir', 'Ananya', 'Diya'])
    expect(ids('fee', 'desc')).toEqual(['Diya', 'Ananya', 'Kabir'])
    expect(ids('status')).toEqual(['Kabir', 'Ananya', 'Diya'])
    expect(ids('owes', 'desc')).toEqual(['Kabir', 'Ananya', 'Diya'])
    expect(ids('tenure', 'desc')).toEqual(['Diya', 'Ananya', 'Kabir'])
  })

  it('groups under headings, with "No …" last', () => {
    const groups = (by: Parameters<typeof groupStudents>[1]) =>
      groupStudents([a, b, c], by, byId).map((g) => [g.label, g.students.map((s) => s.name)])
    expect(groups('batch')).toEqual([
      ['Mon/Wed', ['Ananya']],
      ['Sat', ['Kabir']],
      ['No batch', ['Diya']],
    ])
    expect(groups('location')).toEqual([
      ['HSR Layout', ['Kabir']],
      ['Koramangala', ['Ananya']],
      ['No location', ['Diya']],
    ])
    // A student is under every day their batch meets.
    expect(groups('day')).toEqual([
      ['Monday', ['Ananya']],
      ['Wednesday', ['Ananya']],
      ['Saturday', ['Kabir']],
      ['No day set', ['Diya']],
    ])
    expect(groups('status')).toEqual([
      ['Owes', ['Kabir']],
      ['Up to date', ['Ananya', 'Diya']],
    ])
    expect(groupStudents([a, b], 'batch', byId)[0]!.to).toBe('/students/batch/1')
  })
})

describe('forms', () => {
  it('charges a new usual fee only to those paying the old one', () => {
    const b = batch(1, { default_fee_paise: 150000 })
    const list = [
      student(1, { batch_id: 1, monthly_fee_paise: 150000 }),
      student(2, { batch_id: 1, monthly_fee_paise: 120000 }), // their own fee
      student(3, { batch_id: 1, monthly_fee_paise: 180000 }), // already on it
      student(4, { batch_id: 1, monthly_fee_paise: 150000, is_active: false }), // left
      student(5, { batch_id: 2, monthly_fee_paise: 150000 }), // another batch
    ]
    const { change, ownFee } = feeChangeFor(list, b, 180000)
    expect(change.map((s) => s.id)).toEqual([1])
    expect(ownFee.map((s) => s.id)).toEqual([2])
    // No usual fee before: everyone in it is offered the change.
    const none = feeChangeFor(list, batch(1), 180000)
    expect(none.change.map((s) => s.id)).toEqual([1, 2])
  })

  it('sums up the label conversion', () => {
    const preview = (newCount: number, groups: number, students: number): LabelPreview => ({
      groups: Array.from({ length: groups }, (_, i) => ({
        name: `G${i}`,
        labels: [`G${i}`],
        student_count: 1,
        student_names: ['x'],
        existing_batch_id: i < groups - newCount ? 9 : null,
      })),
      student_count: students,
      new_batch_count: newCount,
    })
    expect(previewSentence(preview(5, 5, 42))).toBe('5 new batches from 42 students')
    expect(previewSentence(preview(1, 2, 3))).toBe(
      '1 new batch and 1 batch you already have from 3 students',
    )
  })
})
