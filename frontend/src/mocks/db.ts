/**
 * In-memory store behind the mock API. It mirrors the backend's tables (students, fee_changes,
 * payments) and answers with the same shapes as the real API (`src/api/schema.d.ts`).
 */
import type {
  BatchCreate,
  BatchOverview,
  BatchRead,
  BatchSummary,
  BatchUpdate,
  LabelConversion,
  LabelPreview,
  PaymentCreate,
  PaymentRead,
  PaymentSort,
  PaymentUpdate,
  SortOrder,
  StudentCreate,
  StudentDetail,
  StudentListFilter,
  StudentRead,
  StudentReturn,
  StudentUpdate,
  Weekday,
} from '@/api/types'
import { monthsAhead, needsCheck } from '@/lib/allocation'
import { nextFeeChange, returnFee } from '@/lib/fees'
import { addMonths, currentMonth, formatMonth, today } from '@/lib/format'

import {
  allocation,
  balance,
  creditPaise,
  dashboard,
  feeFor,
  isActive,
  isStillActive,
  ledgerMonths,
  owedPaise,
  paidAheadPaise,
  standingStatus,
  MONTHS_AHEAD,
  suggestPayment,
  tenureMonths,
  type BatchRow,
  type FeeChangeRow,
  type PaymentRow,
  type StudentBook,
  type StudentRow,
} from './ledger'

export interface Fixture {
  students: StudentRow[]
  fees: FeeChangeRow[]
  payments: PaymentRow[]
  batches?: BatchRow[]
}

const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** Ignoring capitals, accents and spaces (backend `same_text_key`). */
export function sameTextKey(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, '')
}

/** A 404 or 422 to send back, in FastAPI's error shape. */
export class MockHttpError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(status: number, body: unknown) {
    super(`Mock API error ${status}`)
    this.status = status
    this.body = body
  }
}

// Years 2000-2099 only, like the backend.
const MONTH_RE = /^20\d{2}-(0[1-9]|1[0-2])$/
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const METHODS = ['upi', 'cash', 'other']

function invalid(field: string, msg: string): never {
  throw new MockHttpError(422, {
    detail: [{ loc: ['body', field], msg, type: 'value_error' }],
  })
}

function notFound(what: string): never {
  throw new MockHttpError(404, { detail: `${what} not found` })
}

function blankToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function checkMonth(field: string, value: string | null | undefined) {
  if (value !== null && value !== undefined && !MONTH_RE.test(value)) {
    invalid(field, 'String should match pattern "^\\d{4}-(0[1-9]|1[0-2])$"')
  }
}

const MONTH_LABELS: Record<string, string> = {
  joined_month: 'Joined month',
  left_month: 'Left month',
  fee_effective_month: 'The month the new fee starts',
  from_month: "The month they're back from",
  for_month: 'Month',
}

/** At most MONTHS_AHEAD months after the current month (backend `check_month`). */
function checkNotTooLate(field: string, month: string | null | undefined, now: string) {
  const latest = addMonths(now, MONTHS_AHEAD)
  if (month && month > latest) {
    invalid(
      field,
      `${MONTH_LABELS[field]} can't be later than ${formatMonth(latest)} (two years from now)`,
    )
  }
}

function nextFeeRead(fees: FeeChangeRow[], after: string) {
  const next = nextFeeChange(fees, after)
  return next
    ? {
        id: next.id,
        effective_month: next.effective_month,
        amount_paise: next.amount_paise,
        kind: next.kind,
      }
    : null
}

function nowIso(): string {
  return new Date().toISOString()
}

export class MockDb {
  students: StudentRow[] = []
  fees: FeeChangeRow[] = []
  payments: PaymentRow[] = []
  batches: BatchRow[] = []
  /** Backups the label conversion took (`pre-batches`), newest last. */
  backups: string[] = []
  private nextId = 1

  constructor(fixture?: Fixture) {
    if (fixture) this.reset(fixture)
  }

  reset(fixture: Fixture): void {
    this.students = fixture.students.map((s) => ({ ...s }))
    this.fees = fixture.fees.map((f) => ({ ...f }))
    this.payments = fixture.payments.map((p) => ({ ...p }))
    this.batches = (fixture.batches ?? []).map((b) => ({ ...b, days: [...b.days] }))
    this.backups = []
    const ids = [...this.students, ...this.fees, ...this.payments, ...this.batches].map(
      (row) => row.id,
    )
    this.nextId = Math.max(0, ...ids) + 1
  }

  private id(): number {
    return this.nextId++
  }

  private now(): string {
    return currentMonth()
  }

  private book(student: StudentRow): StudentBook {
    return {
      student,
      fees: this.fees.filter((f) => f.student_id === student.id),
      payments: this.payments.filter((p) => p.student_id === student.id),
      batchName: this.batchOf(student)?.name ?? null,
    }
  }

  private batchOf(student: StudentRow): BatchRow | undefined {
    return student.batch_id === null
      ? undefined
      : this.batches.find((b) => b.id === student.batch_id)
  }

  private checkBatch(batchId: number | null | undefined) {
    if (batchId != null && !this.batches.some((b) => b.id === batchId)) {
      invalid('batch_id', "That batch doesn't exist any more. Choose another one, or No batch.")
    }
  }

  private findStudent(id: number): StudentRow {
    return this.students.find((s) => s.id === id) ?? notFound('Student')
  }

  private findPayment(id: number): PaymentRow {
    return this.payments.find((p) => p.id === id) ?? notFound('Payment')
  }

  // ---- Students -------------------------------------------------------------------------------

  private toRead(student: StudentRow): StudentRead {
    const book = this.book(student)
    const now = this.now()
    const owed = owedPaise(book, now)
    const credit = creditPaise(book, now)
    return {
      ...student,
      batch_name: this.batchOf(student)?.name ?? null,
      is_active: isStillActive(student, now),
      monthly_fee_paise: feeFor(book.fees, now < student.joined_month ? student.joined_month : now),
      balance_paise: balance(book, now),
      status: standingStatus(owed, credit),
      owed_paise: owed,
      credit_paise: credit,
      paid_ahead_paise: paidAheadPaise(book, now),
      tenure_months: tenureMonths(student, now),
      next_fee_change: nextFeeRead(
        book.fees,
        now < student.joined_month ? student.joined_month : now,
      ),
      current_month: now,
    }
  }

  private toDetail(student: StudentRow): StudentDetail {
    const book = this.book(student)
    return {
      ...this.toRead(student),
      fee_history: book.fees
        .toSorted((a, b) => a.effective_month.localeCompare(b.effective_month))
        .map(({ id, effective_month, amount_paise, kind }) => ({
          id,
          effective_month,
          amount_paise,
          kind,
        })),
      months: ledgerMonths(book, this.now()),
      payment_count: book.payments.length,
      total_paid_paise: book.payments.reduce((sum, p) => sum + p.amount_paise, 0),
    }
  }

  listStudents(
    status: StudentListFilter = 'active',
    q?: string | null,
    batch?: string | null,
    location?: string | null,
  ): StudentRead[] {
    const needle = q?.trim().toLowerCase()
    const now = this.now()
    const place = location?.trim() ? sameTextKey(location) : null
    if (batch && batch.toLowerCase() !== 'none' && !/^\d+$/.test(batch)) {
      throw new MockHttpError(422, {
        detail: [
          {
            loc: ['query', 'batch'],
            msg: 'Choose a batch by its number, or none',
            type: 'value_error',
          },
        ],
      })
    }
    return this.students
      .filter((s) => {
        if (batch && batch.toLowerCase() === 'none' && s.batch_id !== null) return false
        if (batch && /^\d+$/.test(batch) && s.batch_id !== Number(batch)) return false
        if (place !== null) {
          const where = this.batchOf(s)?.location
          if (!where || sameTextKey(where) !== place) return false
        }
        if (status === 'active' && !isStillActive(s, now)) return false
        if (status === 'left' && isStillActive(s, now)) return false
        if (!needle) return true
        const phone = s.phone?.replace(/\s+/g, '')
        return (
          [s.name, s.guardian_name].some((v) => v?.toLowerCase().includes(needle)) ||
          Boolean(phone?.includes(needle.replace(/\s+/g, '')))
        )
      })
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((s) => this.toRead(s))
  }

  getStudent(id: number): StudentDetail {
    return this.toDetail(this.findStudent(id))
  }

  createStudent(body: StudentCreate): StudentDetail {
    const name = blankToNull(body.name)
    if (!name) invalid('name', 'Name is required')
    if (!Number.isInteger(body.monthly_fee_paise) || body.monthly_fee_paise < 0) {
      invalid('monthly_fee_paise', 'Input should be greater than or equal to 0')
    }
    checkMonth('joined_month', body.joined_month)
    checkMonth('left_month', body.left_month)
    if (body.left_month && body.left_month < body.joined_month) {
      invalid('left_month', "Left month can't be before the joined month")
    }
    checkNotTooLate('joined_month', body.joined_month, this.now())
    checkNotTooLate('left_month', body.left_month, this.now())
    this.checkBatch(body.batch_id)
    const now = nowIso()
    const student: StudentRow = {
      id: this.id(),
      name,
      phone: blankToNull(body.phone),
      guardian_name: blankToNull(body.guardian_name),
      batch_label: blankToNull(body.batch_label),
      batch_id: body.batch_id ?? null,
      joined_month: body.joined_month,
      left_month: body.left_month ?? null,
      notes: blankToNull(body.notes),
      created_at: now,
      updated_at: now,
    }
    this.students.push(student)
    this.fees.push({
      id: this.id(),
      student_id: student.id,
      effective_month: student.joined_month,
      amount_paise: body.monthly_fee_paise,
      kind: 'fee',
    })
    return this.toDetail(student)
  }

  /** Mirrors `update_student` in backend/app/services/students.py, including its 422s. */
  updateStudent(id: number, body: StudentUpdate): StudentDetail {
    const student = this.findStudent(id)
    const now = this.now()
    const next = { ...student }
    if ('name' in body) {
      const name = blankToNull(body.name)
      if (!name) invalid('name', 'Name is required')
      next.name = name
    }
    for (const key of ['phone', 'guardian_name', 'batch_label', 'notes'] as const) {
      if (key in body) next[key] = blankToNull(body[key])
    }
    if ('batch_id' in body) {
      this.checkBatch(body.batch_id)
      next.batch_id = body.batch_id ?? null
    }
    const fee = body.monthly_fee_paise
    if (fee !== undefined && fee !== null && (!Number.isInteger(fee) || fee < 0)) {
      invalid('monthly_fee_paise', 'Input should be greater than or equal to 0')
    }
    if (body.fee_effective_month != null && fee == null) {
      invalid('fee_effective_month', 'Send the new monthly fee together with the month it starts')
    }
    checkMonth('joined_month', body.joined_month)
    checkMonth('left_month', body.left_month)
    checkMonth('fee_effective_month', body.fee_effective_month)
    if (body.left_month && body.joined_month && body.left_month < body.joined_month) {
      invalid('left_month', "Left month can't be before the joined month")
    }

    const own = this.fees
      .filter((f) => f.student_id === id)
      .toSorted((a, b) => a.effective_month.localeCompare(b.effective_month))
    const joined = body.joined_month || student.joined_month
    checkNotTooLate('joined_month', body.joined_month, now)
    checkNotTooLate('left_month', body.left_month, now)
    checkNotTooLate('fee_effective_month', body.fee_effective_month, now)
    const later = own[1]
    if (joined !== student.joined_month && later && joined >= later.effective_month) {
      invalid(
        'joined_month',
        `The joined month can't be on or after a later fee change (${formatMonth(later.effective_month)}). Change that fee first.`,
      )
    }
    const leftSent = 'left_month' in body
    const left = leftSent ? (body.left_month ?? null) : student.left_month
    const stored = student.left_month
    if (leftSent && stored !== null && stored < now && (left === null || left > stored)) {
      invalid(
        'left_month',
        `They left after ${formatMonth(stored)}, so this can only move earlier. If they came back: first set the real last month they paid for before leaving (an earlier one is fine), then use Mark as coming again from the month they came back. Set a new Left month after that if needed.`,
      )
    }
    if (left !== null && left !== stored) this.dropStaleAway(id, left)
    if (left !== null && left < joined) {
      invalid(
        leftSent ? 'left_month' : 'joined_month',
        "Left month can't be before the joined month",
      )
    }
    let feeMonth: string | null = null
    if (fee != null) {
      feeMonth = body.fee_effective_month ?? (now > joined ? now : joined)
      if (feeMonth < joined) {
        invalid('fee_effective_month', "The new fee can't start before the joined month")
      }
    }

    next.joined_month = joined
    next.left_month = left
    if (joined !== student.joined_month && own[0]) own[0].effective_month = joined
    if (feeMonth !== null && fee != null) this.setFeeFrom(id, feeMonth, fee)

    Object.assign(student, next, { updated_at: nowIso() })
    return this.toDetail(student)
  }

  /** Mirrors `set_fee_from`: an upsert on that month's fee change, or nothing if already so. */
  private setFeeFrom(id: number, month: string, fee: number) {
    const own = this.fees.filter((f) => f.student_id === id)
    const existing = own.find((f) => f.effective_month === month)
    // A fee change for a month that already has one replaces its amount.
    if (existing) Object.assign(existing, { amount_paise: fee, kind: 'fee' })
    else if (feeFor(own, month) !== fee) {
      this.fees.push({
        id: this.id(),
        student_id: id,
        effective_month: month,
        amount_paise: fee,
        kind: 'fee',
      })
    }
  }

  /** Mirrors `return_student` in backend/app/services/students.py, including its 422s. */
  returnStudent(id: number, body: StudentReturn): StudentDetail {
    const student = this.findStudent(id)
    const now = this.now()
    const left = student.left_month
    if (left === null) invalid('from_month', "They haven't been marked as left")
    checkMonth('from_month', body.from_month)
    if (!body.from_month) invalid('from_month', 'Field required')
    const back = body.from_month
    const firstAway = addMonths(left, 1)
    if (back < firstAway) {
      invalid(
        'from_month',
        `They can only be back from ${formatMonth(firstAway)} on, the month after they left`,
      )
    }
    checkNotTooLate('from_month', back, now)
    if (body.monthly_fee_paise != null) {
      const fee = body.monthly_fee_paise
      if (!Number.isInteger(fee) || fee < 0 || fee > 100_000_000) {
        invalid('monthly_fee_paise', 'Input should be less than or equal to 100000000')
      }
    }
    const own = () => this.fees.filter((f) => f.student_id === id)
    const feeBack = body.monthly_fee_paise ?? returnFee(own(), back)
    this.fees = this.fees.filter(
      (f) =>
        f.student_id !== id ||
        !(
          (f.effective_month > left && f.effective_month < back) ||
          (f.kind === 'away' && f.effective_month > left)
        ),
    )
    const gap = back > firstAway
    if (gap) {
      this.fees.push({
        id: this.id(),
        student_id: id,
        effective_month: firstAway,
        amount_paise: 0,
        kind: 'away',
      })
    }
    const atBack = own().find((f) => f.effective_month === back)
    if (atBack) Object.assign(atBack, { amount_paise: feeBack, kind: 'fee' })
    else if (gap || feeFor(own(), back) !== feeBack) {
      this.fees.push({
        id: this.id(),
        student_id: id,
        effective_month: back,
        amount_paise: feeBack,
        kind: 'fee',
      })
    }
    Object.assign(student, { left_month: null, updated_at: nowIso() })
    return this.toDetail(student)
  }

  /** Mirrors `_drop_stale_away`: 'away' runs that reach the new left month, or come after it. */
  private dropStaleAway(id: number, left: string) {
    const own = this.fees
      .filter((f) => f.student_id === id)
      .toSorted((a, b) => a.effective_month.localeCompare(b.effective_month))
    const stale = new Set<number>()
    own.forEach((row, i) => {
      if (row.kind !== 'away') return
      const end = own.slice(i + 1).find((f) => f.kind === 'fee')?.effective_month
      if (end === undefined || addMonths(end, -1) >= left) stale.add(row.id)
    })
    this.fees = this.fees.filter((f) => !stale.has(f.id))
  }

  /** Mirrors `delete_fee_change` in backend/app/services/students.py. */
  deleteFeeChange(studentId: number, feeChangeId: number): void {
    this.findStudent(studentId)
    const own = this.fees
      .filter((f) => f.student_id === studentId)
      .toSorted((a, b) => a.effective_month.localeCompare(b.effective_month))
    const change = own.find((f) => f.id === feeChangeId) ?? notFound('Fee change')
    const refuse = (msg: string): never => {
      throw new MockHttpError(422, {
        detail: [{ loc: ['path', 'fee_change_id'], msg, type: 'value_error' }],
      })
    }
    if (change === own[0]) refuse("The first fee can't be removed. To change it, use Edit.")
    if (change.kind === 'fee' && own[own.indexOf(change) - 1]?.kind === 'away') {
      refuse('This is the fee they came back on. To change it, set a new fee in Edit.')
    }
    if (change.effective_month <= this.now()) {
      refuse(
        "Only a fee change that hasn't started yet can be removed. To change a fee that has " +
          'started, set a new fee with Edit.',
      )
    }
    this.fees = this.fees.filter((f) => f.id !== feeChangeId)
  }

  deleteStudent(id: number): void {
    this.findStudent(id)
    this.students = this.students.filter((s) => s.id !== id)
    this.fees = this.fees.filter((f) => f.student_id !== id)
    this.payments = this.payments.filter((p) => p.student_id !== id)
  }

  suggestPayment(id: number) {
    return suggestPayment(this.book(this.findStudent(id)), this.now())
  }

  // ---- Payments -------------------------------------------------------------------------------

  private toPaymentRead(payment: PaymentRow): PaymentRead {
    const student = this.students.find((s) => s.id === payment.student_id)
    const use = student
      ? allocation(this.book(student), this.now()).uses.find((u) => u.payment.id === payment.id)
      : undefined
    return {
      ...payment,
      student_name: student?.name ?? '',
      paid_direct_paise: use?.paid_direct_paise ?? 0,
      needs_check: use ? needsCheck({ ...use, for_month: payment.for_month }, this.now()) : false,
      months_ahead: use ? monthsAhead({ ...use, for_month: payment.for_month }, this.now()) : 0,
      extra_sent: use?.extra_sent ?? [],
      extra_unused_paise: use?.extra_unused_paise ?? payment.amount_paise,
    }
  }

  listPayments(params: {
    student_id?: number | null
    month?: string | null
    q?: string | null
    sort?: PaymentSort
    order?: SortOrder
  }): PaymentRead[] {
    checkMonth('month', params.month)
    const needle = params.q?.trim().toLowerCase()
    const rows = this.payments
      .map((p) => this.toPaymentRead(p))
      .filter((p) => {
        if (params.student_id && p.student_id !== params.student_id) return false
        if (params.month && p.for_month !== params.month) return false
        if (!needle) return true
        return (
          p.student_name.toLowerCase().includes(needle) ||
          (p.note ?? '').toLowerCase().includes(needle)
        )
      })
    const sort = params.sort ?? 'paid_on'
    const dir = (params.order ?? 'desc') === 'asc' ? 1 : -1
    const key = (p: PaymentRead): string | number =>
      ({
        paid_on: p.paid_on,
        for_month: p.for_month,
        amount: p.amount_paise,
        student: p.student_name.toLowerCase(),
        method: p.method,
      })[sort]
    return rows.sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      if (ka < kb) return -dir
      if (ka > kb) return dir
      return b.paid_on.localeCompare(a.paid_on) || b.id - a.id
    })
  }

  getPayment(id: number): PaymentRead {
    return this.toPaymentRead(this.findPayment(id))
  }

  private validatePayment(p: Omit<PaymentRow, 'id' | 'created_at' | 'updated_at'>) {
    if (!this.students.some((s) => s.id === p.student_id)) notFound('Student')
    if (!Number.isInteger(p.amount_paise) || p.amount_paise <= 0) {
      invalid('amount_paise', 'Input should be greater than 0')
    }
    if (!DATE_RE.test(p.paid_on)) invalid('paid_on', 'Enter a valid date')
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    if (p.paid_on < '2000-01-01') invalid('paid_on', "Paid-on date can't be before the year 2000")
    if (p.paid_on > today(tomorrow)) invalid('paid_on', "Paid-on date can't be in the future")
    checkMonth('for_month', p.for_month)
    checkNotTooLate('for_month', p.for_month, this.now())
    if (!METHODS.includes(p.method)) invalid('method', "Input should be 'upi', 'cash' or 'other'")
  }

  createPayment(body: PaymentCreate): PaymentRead {
    const fields = {
      student_id: body.student_id,
      amount_paise: body.amount_paise,
      paid_on: body.paid_on,
      for_month: body.for_month,
      method: body.method,
      note: blankToNull(body.note),
    }
    this.validatePayment(fields)
    const now = nowIso()
    const payment: PaymentRow = { id: this.id(), ...fields, created_at: now, updated_at: now }
    this.payments.push(payment)
    return this.toPaymentRead(payment)
  }

  updatePayment(id: number, body: PaymentUpdate): PaymentRead {
    const payment = this.findPayment(id)
    const next = { ...payment }
    if (body.student_id != null) next.student_id = body.student_id
    if (body.amount_paise != null) next.amount_paise = body.amount_paise
    if (body.paid_on != null) next.paid_on = body.paid_on
    if (body.for_month != null) next.for_month = body.for_month
    if (body.method != null) next.method = body.method
    if ('note' in body) next.note = blankToNull(body.note)
    this.validatePayment(next)
    Object.assign(payment, next, { updated_at: nowIso() })
    return this.toPaymentRead(payment)
  }

  deletePayment(id: number): void {
    this.findPayment(id)
    this.payments = this.payments.filter((p) => p.id !== id)
  }

  // ---- Dashboard ------------------------------------------------------------------------------

  dashboard(month?: string | null) {
    checkMonth('month', month)
    return dashboard(
      this.students.map((s) => this.book(s)),
      month ?? this.now(),
      this.now(),
    )
  }

  // ---- Batches --------------------------------------------------------------------------------

  private findBatch(id: number): BatchRow {
    return this.batches.find((b) => b.id === id) ?? notFound('Batch')
  }

  private toBatchRead(batch: BatchRow): BatchRead {
    const now = this.now()
    const members = this.students.filter((s) => s.batch_id === batch.id)
    return {
      ...batch,
      days: [...batch.days],
      student_count: members.length,
      active_student_count: members.filter((s) => isStillActive(s, now)).length,
    }
  }

  listBatches(): BatchRead[] {
    return this.batches
      .toSorted(
        (a, b) =>
          a.name.localeCompare(b.name, 'en', { sensitivity: 'base', numeric: true }) || a.id - b.id,
      )
      .map((b) => this.toBatchRead(b))
  }

  getBatch(id: number): BatchRead {
    return this.toBatchRead(this.findBatch(id))
  }

  private checkBatchFields(body: BatchUpdate, stored?: BatchRow) {
    if ('name' in body) {
      const name = blankToNull(body.name)
      if (!name) invalid('name', 'Name is required')
      const clash = this.batches.find(
        (b) => b.id !== stored?.id && sameTextKey(b.name) === sameTextKey(name),
      )
      if (clash)
        invalid('name', `There's already a batch called ${clash.name}. Choose another name.`)
    }
    for (const key of ['start_time', 'end_time'] as const) {
      const value = blankToNull(body[key])
      if (value !== null && !TIME_RE.test(value)) invalid(key, 'Enter a time like 17:30')
    }
    const start = 'start_time' in body ? blankToNull(body.start_time) : (stored?.start_time ?? null)
    const end = 'end_time' in body ? blankToNull(body.end_time) : (stored?.end_time ?? null)
    if (start !== null && end !== null && end <= start) {
      invalid(
        'end_time' in body ? 'end_time' : 'start_time',
        'The end time must be after the start time',
      )
    }
    const fee = body.default_fee_paise
    if (fee != null && (!Number.isInteger(fee) || fee < 0 || fee > 100_000_000)) {
      invalid('default_fee_paise', 'Input should be less than or equal to 100000000')
    }
  }

  createBatch(body: BatchCreate): BatchRead {
    this.checkBatchFields(body)
    const now = nowIso()
    const batch: BatchRow = {
      id: this.id(),
      name: blankToNull(body.name)!,
      location: blankToNull(body.location),
      days: WEEKDAYS.filter((d) => (body.days ?? []).includes(d)),
      start_time: blankToNull(body.start_time),
      end_time: blankToNull(body.end_time),
      default_fee_paise: body.default_fee_paise ?? null,
      notes: blankToNull(body.notes),
      created_at: now,
      updated_at: now,
    }
    this.batches.push(batch)
    return this.toBatchRead(batch)
  }

  /** Mirrors `update_batch` in backend/app/services/batches.py, `apply_fee` included. */
  updateBatch(id: number, body: BatchUpdate): BatchRead {
    const batch = this.findBatch(id)
    this.checkBatchFields(body, batch)
    if (body.apply_fee && body.default_fee_paise == null) {
      invalid('apply_fee', 'Send the new fee together with the students to charge it to')
    }
    if (body.apply_fee && body.default_fee_paise != null) {
      const from = body.apply_fee.from_month
      checkMonth('from_month', from)
      const members = body.apply_fee.student_ids.map((sid) =>
        this.students.find((s) => s.id === sid),
      )
      if (members.some((s) => !s || s.batch_id !== id)) {
        invalid(
          'apply_fee',
          "Some of those students aren't in this batch any more. Close this and try again.",
        )
      }
      for (const student of members as StudentRow[]) {
        let month = from > student.joined_month ? from : student.joined_month
        if (student.left_month !== null && month > student.left_month) continue
        const own = this.fees
          .filter((f) => f.student_id === student.id)
          .toSorted((a, b) => a.effective_month.localeCompare(b.effective_month))
        const inEffect = own.filter((f) => f.effective_month <= month).at(-1)
        if (inEffect?.kind === 'away') {
          const back = own.find((f) => f.effective_month > month && f.kind === 'fee')
          if (!back) continue
          month = back.effective_month
        }
        this.setFeeFrom(student.id, month, body.default_fee_paise)
      }
    }
    if ('name' in body) batch.name = blankToNull(body.name)!
    for (const key of ['location', 'start_time', 'end_time', 'notes'] as const) {
      if (key in body) batch[key] = blankToNull(body[key])
    }
    if ('default_fee_paise' in body) batch.default_fee_paise = body.default_fee_paise ?? null
    if (body.days) batch.days = WEEKDAYS.filter((d) => body.days!.includes(d))
    batch.updated_at = nowIso()
    return this.toBatchRead(batch)
  }

  deleteBatch(id: number): void {
    this.findBatch(id)
    for (const s of this.students) if (s.batch_id === id) s.batch_id = null
    this.batches = this.batches.filter((b) => b.id !== id)
  }

  /** Each batch's numbers for a month: the dashboard's summary over its students. */
  batchOverview(month?: string | null): BatchOverview {
    checkMonth('month', month)
    const now = this.now()
    const m = month ?? now
    const summary = (batchId: number | null): BatchSummary => {
      const members = this.students.filter((s) => s.batch_id === batchId)
      const s = dashboard(
        members.map((st) => this.book(st)),
        m,
        now,
      ).summary
      const paid = s.expected_paise - s.still_due_paise
      return {
        batch_id: batchId,
        student_count: members.filter((st) => isActive(st, m)).length,
        active_student_count: s.active_student_count,
        expected_paise: s.expected_paise,
        collected_paise: s.collected_paise,
        still_due_paise: s.still_due_paise,
        paid_ahead_paise: s.paid_ahead_paise,
        not_fully_paid_count: s.not_fully_paid_count,
        paid_percent: s.expected_paise > 0 ? Math.floor((paid * 100) / s.expected_paise) : null,
      }
    }
    return {
      month: m,
      current_month: now,
      batches: this.listBatches().map((b) => summary(b.id)),
      no_batch: summary(null),
    }
  }

  private labelGroups() {
    const groups = new Map<string, StudentRow[]>()
    for (const s of this.students) {
      if (s.batch_id !== null || !s.batch_label) continue
      const key = sameTextKey(s.batch_label)
      if (!key) continue
      groups.set(key, [...(groups.get(key) ?? []), s])
    }
    return [...groups.entries()]
      .map(([key, students]) => {
        const counts = new Map<string, number>()
        for (const s of students) {
          const label = s.batch_label!.trim().split(/\s+/).join(' ')
          counts.set(label, (counts.get(label) ?? 0) + 1)
        }
        const labels = [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([label]) => label)
        const existing = this.batches.find((b) => sameTextKey(b.name) === key)
        return {
          key,
          name: existing?.name ?? labels[0]!,
          labels,
          students: students.toSorted((a, b) => a.name.localeCompare(b.name)),
          existing,
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
  }

  labelPreview(): LabelPreview {
    const groups = this.labelGroups()
    return {
      groups: groups.map((g) => ({
        name: g.name,
        labels: g.labels,
        student_count: g.students.length,
        student_names: g.students.map((s) => s.name),
        existing_batch_id: g.existing?.id ?? null,
      })),
      student_count: groups.reduce((sum, g) => sum + g.students.length, 0),
      new_batch_count: groups.filter((g) => !g.existing).length,
    }
  }

  convertLabels(): LabelConversion {
    const groups = this.labelGroups()
    if (groups.length === 0) return { batches_created: 0, students_placed: 0, backup_file: null }
    const backup = `records-pre-batches-${this.backups.length + 1}.db`
    this.backups.push(backup)
    let created = 0
    let placed = 0
    for (const g of groups) {
      const batch = g.existing ?? this.createBatch({ name: g.name })
      if (!g.existing) created += 1
      for (const s of g.students) {
        s.batch_id = batch.id
        placed += 1
      }
    }
    return { batches_created: created, students_placed: placed, backup_file: backup }
  }
}
