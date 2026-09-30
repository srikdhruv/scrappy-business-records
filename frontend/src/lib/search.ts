/**
 * Finding a student by what someone types. One matcher for the Students page search and the
 * Log payment student list, so both find the same people:
 *
 * - capitals and accents don't matter ("emile" finds "Émile");
 * - the words can come in any order ("menon arjun" finds "Arjun Menon");
 * - apostrophes and hyphens in names don't matter ("obrien" finds "O’Brien");
 * - spaces and punctuation in phone numbers don't matter ("9000000006" finds "90000 00006",
 *   and "90000-00006" finds it too), nor does +91 in front ("+91 90000 00006").
 */

/**
 * Lower-case, with accents removed, for comparing text. Apostrophes and hyphens go too, so
 * "obrien", "o'brien" and "O’Brien" are the same, and "dsouza" finds "D'Souza".
 */
export function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/['’‘`´-]/g, '')
    .toLowerCase()
}

/** The digits of a phone number, without India's +91 (or 0) in front of a 10-digit number. */
const digitsOf = (text: string) => {
  const digits = text.replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2)
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1)
  return digits
}

/** Only digits and what people put between them in a phone number. */
const PHONE_LIKE = /^[\d\s()+\-./]+$/

export interface Searchable {
  name: string
  phone?: string | null
  guardian_name?: string | null
  batch_label?: string | null
}

/**
 * True when every word typed appears in the student's name, parent's name, class or phone. A
 * word that is only digits (and phone punctuation) also matches the phone number's digits,
 * ignoring its spaces and punctuation. So does everything typed, taken together, if it's only a
 * phone number.
 */
export function studentMatches(student: Searchable, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const text = fold(
    [student.name, student.guardian_name, student.batch_label, student.phone]
      .filter(Boolean)
      .join(' '),
  )
  const phone = digitsOf(student.phone ?? '')
  const inPhone = (typed: string) => {
    const digits = digitsOf(typed)
    return digits.length > 0 && phone.includes(digits)
  }
  // "98765 43210" typed for "9876543210" saved, and the other way round.
  if (PHONE_LIKE.test(query.trim()) && inPhone(query)) return true
  return words.every((word) => text.includes(word) || (PHONE_LIKE.test(word) && inPhone(word)))
}
