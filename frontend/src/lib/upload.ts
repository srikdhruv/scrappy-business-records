/**
 * The Upload Excel preview's arithmetic: where each row ends up with the owner's choices, and the
 * sentences that say so. Kept apart from the dialog so it can be tested on its own.
 */
import type { ImportPaymentPreview, ImportPreview, ImportStudentPreview } from '@/api/types'
import { plural } from '@/lib/labels'

/** The Payments page section's id, so the Dashboard can link to it. */
export const UNASSIGNED_SECTION_ID = 'unassigned-payments'

/**
 * What to do with a payment: keep it unassigned, skip it, give it to a student, or (for one that
 * looks like a duplicate) add it anyway. 'pick' means "another student", not chosen yet.
 */
export type PaymentChoice = 'unassigned' | 'skip' | 'pick' | 'add' | `student:${number}`

export interface Choices {
  /** "Looks similar" students (by row): add them (true) or skip them (false). Missing: the
   * default, which is Skip unless the row says `add_by_default`. */
  students: Map<number, boolean>
  /** By payment key (`sheet:row`). Missing means the default for its status. */
  payments: Map<string, PaymentChoice>
}

export const paymentKey = (p: ImportPaymentPreview) => `${p.sheet}:${p.row}`

export const emptyChoices = (): Choices => ({ students: new Map(), payments: new Map() })

export const isDuplicate = (p: ImportPaymentPreview) =>
  p.status === 'duplicate' || p.status === 'possible_duplicate'

export function studentAdded(s: ImportStudentPreview, choices: Choices): boolean {
  if (s.status === 'new') return true
  if (s.status !== 'similar') return false
  return choices.students.get(s.row) ?? s.add_by_default
}

/** Where a payment will end up with these choices. */
export function paymentOutcome(
  p: ImportPaymentPreview,
  choices: Choices,
  studentStatus: Map<number, ImportStudentPreview>,
): 'add' | 'unassigned' | 'skip' {
  if (p.status === 'problem') return 'skip'
  const choice = choices.payments.get(paymentKey(p))
  if (choice === 'skip') return 'skip'
  if (choice?.startsWith('student:')) return 'add'
  if (choice === 'unassigned') return 'unassigned'
  if (isDuplicate(p) && choice !== 'add') return 'skip'
  const student = p.student_row !== null ? studentStatus.get(p.student_row) : undefined
  if (p.student_id !== null) return 'add'
  if (student) return studentAdded(student, choices) ? 'add' : 'unassigned'
  return 'unassigned' // needs_student and the Unassigned payments sheet
}

export interface Summary {
  students: number
  payments: number
  unassigned: number
  alreadyHere: number
  toChoose: number
  problems: number
}

/**
 * What adding the file would do with these choices. The preview lists every row that needs a
 * choice, and only counts most of the others (a big file), so the counts come from the server
 * and the listed choice rows adjust them.
 */
export function summarize(preview: ImportPreview, choices: Choices): Summary {
  const count = (counts: Record<string, number>, ...statuses: string[]) =>
    statuses.reduce((sum, status) => sum + (counts[status] ?? 0), 0)
  const students = preview.student_counts
  const payments = preview.payment_counts
  const byRow = new Map(preview.students.map((s) => [s.row, s]))
  // Rows whose outcome depends on a choice: all of them are listed.
  const chosen = preview.payments.filter(
    (p) => needsChoice(p) || p.status === 'follows_student' || p.status === 'duplicate',
  )
  const outcomes = chosen.map((p) => paymentOutcome(p, choices, byRow))
  const addedAnyway = chosen.filter((p, i) => p.status === 'duplicate' && outcomes[i] === 'add')
  return {
    students:
      count(students, 'new') +
      preview.students.filter((s) => s.status === 'similar' && studentAdded(s, choices)).length,
    payments: count(payments, 'ready') + outcomes.filter((o) => o === 'add').length,
    unassigned: count(payments, 'unassigned') + outcomes.filter((o) => o === 'unassigned').length,
    alreadyHere: count(students, 'exists') + count(payments, 'duplicate') - addedAnyway.length,
    toChoose: count(students, 'similar') + count(payments, 'needs_student', 'possible_duplicate'),
    problems: count(students, 'problem') + count(payments, 'problem'),
  }
}

/** How many rows the file has in all (the preview may list only some of them). */
export function rowCount(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0)
}

/** The file as base64, as Add sends it (the server reads it again). */
export function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Rows the To choose tab shows: look-alikes, payments without a student, possible duplicates. */
export function needsChoice(row: { status: string }): boolean {
  return (
    row.status === 'similar' ||
    row.status === 'needs_student' ||
    row.status === 'possible_duplicate'
  )
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

/** Batches that adding would create: the file's new ones (its Batches sheet), and the
 * not-found ones she ticked "Create it" for. */
export function batchesToCreate(preview: ImportPreview, create: ReadonlySet<string>): number {
  return (preview.batches ?? []).filter((b) => b.status === 'new').length + create.size
}
