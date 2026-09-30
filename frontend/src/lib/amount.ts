/** Plain-words checks for what someone types into an amount box (payments and fees). */
import { formatRupees, MAX_AMOUNT_PAISE, rupeesToPaise } from '@/lib/format'

/**
 * The problem with `input` as an amount, or null if it's fine. `allowZero` for fees.
 * "15,00" -> "Enter an amount like…"; "20,00,000" -> "The most you can enter is ₹10,00,000."
 */
export function amountProblem(
  input: string,
  { allowZero = false, what = 'amount' }: { allowZero?: boolean; what?: string } = {},
): string | null {
  if (input.trim() === '') return `Enter the ${what}.`
  const paise = rupeesToPaise(input, { allowZero: true })
  if (paise === null) {
    // Well-formed but too big? Say so, instead of a puzzling format message.
    const digits = input.replace(/^\s*(?:₹|rs\.?|inr)\s*/i, '').replace(/[,\s]/g, '')
    if (/^\d+(?:\.\d{0,2})?$/.test(digits) && Number(digits) * 100 > MAX_AMOUNT_PAISE) {
      return `The most you can enter is ${formatRupees(MAX_AMOUNT_PAISE)}.`
    }
    const article = /^[aeiou]/i.test(what) ? 'an' : 'a'
    return `Enter ${article} ${what} like 1500 or 1,500.`
  }
  if (paise === 0 && !allowZero) return `The ${what} must be more than ₹0.`
  return null
}
