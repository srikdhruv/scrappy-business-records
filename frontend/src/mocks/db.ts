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
} from '@/api/schema'
import { currentMonth } from '@/lib/format'

import {
  balance,
  balanceStatus,
  dashboard,
  feeFor,
  ledgerMonths,
  suggestPayment,
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

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
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
      is_active: student.left_month === null,
      monthly_fee_paise: feeFor(book.fees, now < student.joined_month ? student.joined_month : now),
      balance_paise: bal,
      status: balanceStatus(bal),
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
    return this.students
      .filter((s) => {
        if (status === 'active' && s.left_month !== null) return false
        if (status === 'left' && s.left_month === null) return false
        if (!needle) return true
        return [s.name, s.phone, s.guardian_name].some((v) => v?.toLowerCase().includes(needle))
      })
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((s) => this.toRead(s))
  }

  getStudent(id: number): StudentDetail {
    return this.toDetail(this.findStudent(id))
  }

  createStudent(body: StudentCreate): StudentDetail {
    const name = blankToNull(body.name)
    if (!name) invalid('name', 'Enter a name')
    if (!Number.isInteger(body.monthly_fee_paise) || body.monthly_fee_paise < 0) {
      invalid('monthly_fee_paise', 'Fee must be 0 or more')
    }
    checkMonth('joined_month', body.joined_month)
    checkMonth('left_month', body.left_month)
    if (body.left_month && body.left_month < body.joined_month) {
      invalid('left_month', 'Left month cannot be before the joined month')
    }
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

  updateStudent(id: number, body: StudentUpdate): StudentDetail {
    const student = this.findStudent(id)
    const next = { ...student }
    if ('name' in body) {
      const name = blankToNull(body.name)
      if (!name) invalid('name', 'Enter a name')
      next.name = name
    }
    for (const key of ['phone', 'guardian_name', 'batch_label', 'notes'] as const) {
      if (key in body) next[key] = blankToNull(body[key])
    }
    if (
      body.monthly_fee_paise !== undefined &&
      body.monthly_fee_paise !== null &&
      (!Number.isInteger(body.monthly_fee_paise) || body.monthly_fee_paise < 0)
    ) {
      invalid('monthly_fee_paise', 'Fee must be 0 or more')
    }
    const own = this.fees
      .filter((f) => f.student_id === id)
      .toSorted((a, b) => a.effective_month.localeCompare(b.effective_month))
    if (body.joined_month) {
      checkMonth('joined_month', body.joined_month)
      // Edit rule 1: the earliest fee moves with joined_month, unless that would swallow a
      // later fee change.
      const later = own[1]
      if (later && body.joined_month >= later.effective_month) {
        invalid('joined_month', 'The joining month can’t be on or after a later fee change')
      }
      next.joined_month = body.joined_month
    }
    if ('left_month' in body) {
      checkMonth('left_month', body.left_month)
      next.left_month = body.left_month ?? null
    }
    if (next.left_month !== null && next.left_month < next.joined_month) {
      invalid('left_month', 'The month they left can’t be before the month they joined')
    }
    if (body.fee_effective_month !== undefined && body.fee_effective_month !== null) {
      if (body.monthly_fee_paise === undefined || body.monthly_fee_paise === null) {
        invalid('fee_effective_month', 'Only allowed together with monthly_fee_paise')
      }
      checkMonth('fee_effective_month', body.fee_effective_month)
      if (body.fee_effective_month < next.joined_month) {
        invalid('fee_effective_month', 'The new fee can’t start before the month they joined')
      }
    }
    if (own[0] && body.joined_month) own[0].effective_month = next.joined_month

    if (body.monthly_fee_paise !== undefined && body.monthly_fee_paise !== null) {
      const effective = body.fee_effective_month ?? this.now()
      const existing = this.fees.find((f) => f.student_id === id && f.effective_month === effective)
      if (existing) existing.amount_paise = body.monthly_fee_paise
      else {
        this.fees.push({
          id: this.id(),
          student_id: id,
          effective_month: effective,
          amount_paise: body.monthly_fee_paise,
        })
      }
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
      invalid('amount_paise', 'Amount must be more than 0')
    }
    if (!DATE_RE.test(p.paid_on)) invalid('paid_on', 'Enter a valid date')
    checkMonth('for_month', p.for_month)
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
