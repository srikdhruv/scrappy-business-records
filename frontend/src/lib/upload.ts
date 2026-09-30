/**
 * The Upload Excel preview's arithmetic: where each row ends up with the owner's choices, and the
 * sentences that say so. Kept apart from the dialog so it can be tested on its own.
 */
import type { ImportPaymentPreview, ImportPreview, ImportStudentPreview } from '@/api/types'
import { plural } from '@/lib/labels'

/** The Payments page section's id, so the Dashboard can link to it. */
export const UNASSIGNED_SECTION_ID = 'unassigned-payments'

/** For a payment that needs a student: keep it unassigned, skip it, or give it to a student. */
export type PaymentChoice = 'unassigned' | 'skip' | 'pick' | `student:${number}`

export interface Choices {
  /** Rows (in the Students sheet) of "looks similar" students to add anyway. */
  addStudents: Set<number>
  /** By payment key (`sheet:row`). Missing means the default for its status. */
  payments: Map<string, PaymentChoice>
}

export const paymentKey = (p: ImportPaymentPreview) => `${p.sheet}:${p.row}`

export const emptyChoices = (): Choices => ({ addStudents: new Set(), payments: new Map() })

/** Where a payment will end up with these choices. */
export function paymentOutcome(
  p: ImportPaymentPreview,
  choices: Choices,
  studentStatus: Map<number, ImportStudentPreview>,
): 'add' | 'unassigned' | 'skip' {
  if (p.status === 'problem' || p.status === 'duplicate') return 'skip'
  const choice = choices.payments.get(paymentKey(p))
  if (choice === 'skip') return 'skip'
  if (choice?.startsWith('student:')) return 'add'
  if (choice === 'unassigned') return 'unassigned'
  if (p.status === 'ready') {
    // A new student in the same file, unless it was taken off the list.
    return 'add'
  }
  if (p.status === 'follows_student' && p.student_row !== null) {
    const student = studentStatus.get(p.student_row)
    return student && studentAdded(student, choices) ? 'add' : 'unassigned'
  }
  return 'unassigned' // needs_student and the Unassigned payments sheet
}

export function studentAdded(s: ImportStudentPreview, choices: Choices): boolean {
  return s.status === 'new' || (s.status === 'similar' && choices.addStudents.has(s.row))
}

export interface Summary {
  students: number
  payments: number
  unassigned: number
  alreadyHere: number
  toChoose: number
  problems: number
}

export function summarize(preview: ImportPreview, choices: Choices): Summary {
  const byRow = new Map(preview.students.map((s) => [s.row, s]))
  const outcomes = preview.payments.map((p) => paymentOutcome(p, choices, byRow))
  return {
    students: preview.students.filter((s) => studentAdded(s, choices)).length,
    payments: outcomes.filter((o) => o === 'add').length,
    unassigned: outcomes.filter((o) => o === 'unassigned').length,
    alreadyHere:
      preview.students.filter((s) => s.status === 'exists').length +
      preview.payments.filter((p) => p.status === 'duplicate').length,
    toChoose:
      preview.students.filter((s) => s.status === 'similar').length +
      preview.payments.filter((p) => p.status === 'needs_student').length,
    problems:
      preview.students.filter((s) => s.status === 'problem').length +
      preview.payments.filter((p) => p.status === 'problem').length,
  }
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** "Will add 12 students and 140 payments. 3 already exist and will be skipped. …" */
export function summarySentence(s: Summary): string {
  const adding = [
    s.students ? plural(s.students, 'student') : '',
    s.payments ? plural(s.payments, 'payment') : '',
  ].filter(Boolean)
  const lines = [adding.length ? `Will add ${joinAnd(adding)}.` : 'Nothing new to add.']
  if (s.unassigned)
    lines.push(
      `${plural(s.unassigned, 'payment')} will be kept as unassigned, to give to a student later.`,
    )
  if (s.alreadyHere)
    lines.push(
      `${s.alreadyHere} already ${s.alreadyHere === 1 ? 'exists' : 'exist'} and will be skipped.`,
    )
  if (s.toChoose) lines.push(`${s.toChoose} ${s.toChoose === 1 ? 'needs' : 'need'} you to choose.`)
  if (s.problems)
    lines.push(
      `${s.problems} ${s.problems === 1 ? 'has a problem' : 'have problems'} and will be skipped.`,
    )
  return lines.join(' ')
}

/** "Added 12 students and 140 payments" for the message afterwards. */
export function addedSentence(students: number, payments: number, unassigned: number): string {
  const parts = [
    students ? plural(students, 'student') : '',
    payments ? plural(payments, 'payment') : '',
    unassigned ? `${plural(unassigned, 'unassigned payment')}` : '',
  ].filter(Boolean)
  return parts.length ? `Added ${joinAnd(parts)}` : 'Nothing was added'
}
