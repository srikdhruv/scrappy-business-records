/**
 * Demo data for the mock API: about 20 obviously fictional students and a year of payments,
 * built relative to "now" so the dashboard always looks lived-in. The mix covers every case the
 * screens handle: fully paid, partial, unpaid, backlog from earlier months, overpaid, paid
 * ahead, a fee change, students who left, and students who joined this month.
 *
 * Every name and phone number here is made up.
 */
import type { PaymentMethod } from '@/api/types'
import { addMonths, currentMonth, today } from '@/lib/format'

import type { Fixture } from './db'
import type { FeeChangeRow, PaymentRow, StudentRow } from './ledger'

interface StudentSpec {
  name: string
  guardian?: string
  batch?: string
  /** Monthly fee in rupees (the current fee, if `feeChange` is set). */
  fee: number
  /** How many months before the current month they joined (0 = this month). */
  joined: number
  /** Last month they owe, in months before the current month. */
  left?: number
  /** An earlier fee, in rupees, that applied until `from` months ago. */
  feeChange?: { oldFee: number; from: number }
  /** Months (as "months ago") with nothing paid. */
  unpaid?: number[]
  /** Months (as "months ago") paid only in part: rupees paid. */
  partial?: Record<number, number>
  /** Months (as "months ago") paid more than the fee: rupees paid. */
  extra?: Record<number, number>
  /** How many future months are already paid. */
  ahead?: number
  method?: PaymentMethod
  notes?: string
}

const TUE_THU = 'Tue/Thu 5pm – Indiranagar'
const MON_WED = 'Mon/Wed 6pm – Koramangala'
const SAT = 'Sat 10am – HSR Layout'
const SUN_KIDS = 'Sun 11am Kids – Indiranagar'

export const DEMO_STUDENTS: StudentSpec[] = [
  { name: 'Ananya Rao', guardian: 'Lakshmi Rao', batch: TUE_THU, fee: 1500, joined: 14 },
  {
    name: 'Kabir Mehta',
    guardian: 'Sunil Mehta',
    batch: MON_WED,
    fee: 1500,
    joined: 11,
    unpaid: [0, 1],
  },
  {
    name: 'Diya Sharma',
    batch: TUE_THU,
    fee: 1800,
    joined: 20,
    feeChange: { oldFee: 1500, from: 5 },
    partial: { 0: 1000 },
    notes: 'Performs in the annual show.',
  },
  {
    name: 'Arjun Nair',
    guardian: 'Deepa Nair',
    batch: SAT,
    fee: 1200,
    joined: 8,
    extra: { 2: 1500 },
  },
  { name: 'Meera Iyer', batch: MON_WED, fee: 2000, joined: 30, ahead: 1, method: 'cash' },
  {
    name: 'Rohan Kulkarni',
    guardian: 'Asha Kulkarni',
    batch: SUN_KIDS,
    fee: 1500,
    joined: 6,
    unpaid: [0, 2, 3],
    notes: 'Parent asked to be reminded on WhatsApp.',
  },
  { name: 'Ishita Banerjee', batch: TUE_THU, fee: 1500, joined: 12 },
  {
    name: 'Vihaan Joshi',
    guardian: 'Pooja Joshi',
    batch: SUN_KIDS,
    fee: 1200,
    joined: 0,
    unpaid: [0],
  },
  { name: 'Saanvi Reddy', guardian: 'Kiran Reddy', batch: SUN_KIDS, fee: 1200, joined: 0 },
  { name: 'Aditya Menon', batch: SAT, fee: 1800, joined: 9, unpaid: [0] },
  { name: 'Tara Pillai', batch: MON_WED, fee: 1500, joined: 13, partial: { 4: 1000 } },
  { name: 'Neel Chatterjee', batch: SAT, fee: 2000, joined: 16 },
  { name: 'Zara Khan', guardian: 'Farah Khan', batch: TUE_THU, fee: 1500, joined: 1 },
  {
    name: 'Aarav Gupta',
    guardian: 'Nisha Gupta',
    batch: MON_WED,
    fee: 1500,
    joined: 10,
    partial: { 0: 500 },
    extra: { 7: 3000 },
  },
  { name: 'Myra Desai', batch: SAT, fee: 1800, joined: 18, method: 'cash' },
  { name: 'Reyansh Bose', guardian: 'Anjali Bose', batch: SUN_KIDS, fee: 1200, joined: 7 },
  { name: 'Kiara Fernandes', batch: TUE_THU, fee: 1500, joined: 5, unpaid: [0] },
  { name: 'Advait Sinha', batch: MON_WED, fee: 1500, joined: 15, left: 3 },
  {
    name: 'Anika Verma',
    guardian: 'Rahul Verma',
    batch: SAT,
    fee: 1500,
    joined: 11,
    left: 1,
    unpaid: [1],
    notes: 'Moved to another city.',
  },
  { name: 'Dev Malhotra', batch: TUE_THU, fee: 1800, joined: 24, left: 8, method: 'cash' },
]

/** Deterministic "random" numbers, so the demo data is the same every time. */
function seeded(seed: number) {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

export function buildFixture(specs: StudentSpec[], now: Date = new Date()): Fixture {
  const thisMonth = currentMonth(now)
  const todayStr = today(now)
  const dayToday = now.getDate()
  const rand = seeded(42)
  let nextId = 1
  const students: StudentRow[] = []
  const fees: FeeChangeRow[] = []
  const payments: PaymentRow[] = []
  const stamp = `${todayStr}T09:00:00Z`

  const pay = (studentId: number, forMonth: string, rupees: number, method: PaymentMethod) => {
    // Most people pay in the first ten days; some pay a few days late, early next month.
    let paidOn: string
    if (forMonth > thisMonth) {
      paidOn = todayStr
    } else {
      const late = rand() < 0.15
      const day = late ? 1 + Math.floor(rand() * 5) : 2 + Math.floor(rand() * 9)
      const month = late ? addMonths(forMonth, 1) : forMonth
      paidOn =
        month > thisMonth || (month === thisMonth && day > dayToday)
          ? todayStr
          : `${month}-${String(day).padStart(2, '0')}`
    }
    payments.push({
      id: nextId++,
      student_id: studentId,
      amount_paise: rupees * 100,
      paid_on: paidOn,
      for_month: forMonth,
      method: rand() < 0.12 ? 'cash' : method,
      note: null,
      created_at: stamp,
      updated_at: stamp,
    })
  }

  specs.forEach((spec, index) => {
    const id = nextId++
    const joined = addMonths(thisMonth, -spec.joined)
    const left = spec.left === undefined ? null : addMonths(thisMonth, -spec.left)
    students.push({
      id,
      name: spec.name,
      phone: `90000 000${String(index + 1).padStart(2, '0')}`,
      guardian_name: spec.guardian ?? null,
      batch_label: spec.batch ?? null,
      joined_month: joined,
      left_month: left,
      notes: spec.notes ?? null,
      created_at: stamp,
      updated_at: stamp,
    })
    if (spec.feeChange) {
      fees.push({
        id: nextId++,
        student_id: id,
        effective_month: joined,
        amount_paise: spec.feeChange.oldFee * 100,
      })
      fees.push({
        id: nextId++,
        student_id: id,
        effective_month: addMonths(thisMonth, -spec.feeChange.from),
        amount_paise: spec.fee * 100,
      })
    } else {
      fees.push({
        id: nextId++,
        student_id: id,
        effective_month: joined,
        amount_paise: spec.fee * 100,
      })
    }

    const method = spec.method ?? 'upi'
    const lastAgo = spec.left ?? 0
    for (let ago = spec.joined; ago >= lastAgo; ago--) {
      if (spec.unpaid?.includes(ago)) continue
      const month = addMonths(thisMonth, -ago)
      const fee = spec.feeChange && ago > spec.feeChange.from ? spec.feeChange.oldFee : spec.fee
      const amount = spec.partial?.[ago] ?? spec.extra?.[ago] ?? fee
      pay(id, month, amount, method)
    }
    for (let ahead = 1; ahead <= (spec.ahead ?? 0); ahead++) {
      pay(id, addMonths(thisMonth, ahead), spec.fee, method)
    }
  })

  const aarav = students.find((s) => s.name === 'Aarav Gupta')
  const withNote = payments.find((p) => p.student_id === aarav?.id && p.amount_paise === 300000)
  if (withNote) withNote.note = 'Paid for two months together'
  return { students, fees, payments }
}

/** The standard demo: ~20 students and a year of payments. */
export function demoFixture(now: Date = new Date()): Fixture {
  return buildFixture(DEMO_STUDENTS, now)
}

/** A brand-new install: nobody yet. */
export function emptyFixture(): Fixture {
  return { students: [], fees: [], payments: [] }
}

/** Everyone active has paid for this month and nobody owes anything. */
export function allPaidFixture(now: Date = new Date()): Fixture {
  return buildFixture(
    DEMO_STUDENTS.filter((s) => s.left === undefined).map((s) => ({
      ...s,
      unpaid: undefined,
      partial: undefined,
    })),
    now,
  )
}
