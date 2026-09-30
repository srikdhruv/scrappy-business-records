/**
 * In-memory store behind the mock API. It mirrors the backend's tables (students, fee_changes,
 * payments) and answers with the same shapes as the real API (`src/api/schema.d.ts`).
 */
import type {
  PaymentCreate,
  PaymentRead,
  PaymentSort,
  PaymentUpdate,
  SortOrder,
  StudentCreate,
  StudentDetail,
  StudentListFilter,
  StudentRead,
  StudentUpdate,
} from '@/api/types'
import { addMonths, currentMonth, formatMonth, today } from '@/lib/format'

import {
  balance,
  balanceStatus,
  creditPaise,
  dashboard,
  feeFor,
  isStillActive,
  ledgerMonths,
  MONTHS_AHEAD,
  suggestPayment,
  tenureMonths,
  type FeeChangeRow,
  type PaymentRow,
  type StudentBook,
  type StudentRow,
} from './ledger'

export interface Fixture {
  students: StudentRow[]
  fees: FeeChangeRow[]
  payments: PaymentRow[]
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

function nowIso(): string {
  return new Date().toISOString()
}

export class MockDb {
  students: StudentRow[] = []
  fees: FeeChangeRow[] = []
  payments: PaymentRow[] = []
  private nextId = 1

  constructor(fixture?: Fixture) {
    if (fixture) this.reset(fixture)
  }

  reset(fixture: Fixture): void {
    this.students = fixture.students.map((s) => ({ ...s }))
    this.fees = fixture.fees.map((f) => ({ ...f }))
    this.payments = fixture.payments.map((p) => ({ ...p }))
    const ids = [...this.students, ...this.fees, ...this.payments].map((row) => row.id)
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
    const bal = balance(book, now)
    return {
      ...student,
      is_active: isStillActive(student, now),
      monthly_fee_paise: feeFor(book.fees, now < student.joined_month ? student.joined_month : now),
      balance_paise: bal,
      status: balanceStatus(bal),
      credit_paise: creditPaise(book, now),
      tenure_months: tenureMonths(student, now),
      current_month: now,
    }
  }

  private toDetail(student: StudentRow): StudentDetail {
    const book = this.book(student)
    return {
      ...this.toRead(student),
      fee_history: book.fees
        .toSorted((a, b) => a.effective_month.localeCompare(b.effective_month))
        .map(({ id, effective_month, amount_paise }) => ({ id, effective_month, amount_paise })),
      months: ledgerMonths(book, this.now()),
      payment_count: book.payments.length,
      total_paid_paise: book.payments.reduce((sum, p) => sum + p.amount_paise, 0),
    }
  }

  listStudents(status: StudentListFilter = 'active', q?: string | null): StudentRead[] {
    const needle = q?.trim().toLowerCase()
    const now = this.now()
    return this.students
      .filter((s) => {
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
    const now = nowIso()
    const student: StudentRow = {
      id: this.id(),
      name,
      phone: blankToNull(body.phone),
      guardian_name: blankToNull(body.guardian_name),
      batch_label: blankToNull(body.batch_label),
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
    if (feeMonth !== null && fee != null && feeFor(own, feeMonth) !== fee) {
      // A fee change for a month that already has one replaces its amount.
      const existing = own.find((f) => f.effective_month === feeMonth)
      if (existing) existing.amount_paise = fee
      else
        this.fees.push({
          id: this.id(),
          student_id: id,
          effective_month: feeMonth,
          amount_paise: fee,
        })
    }

    Object.assign(student, next, { updated_at: nowIso() })
    return this.toDetail(student)
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
    return { ...payment, student_name: student?.name ?? '' }
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
}
