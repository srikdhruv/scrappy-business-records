/**
 * Turning failures into plain words for the person using the app. `ApiError` (api/client.ts)
 * already extracts readable `messages` and a per-field `fields` map from FastAPI's errors; this
 * adds the "server isn't running" case, which throws before any response arrives.
 */
import { ApiError } from '@/api/client'

export const UNREACHABLE_MESSAGE =
  'Can’t reach Scrappy Records. Try closing and reopening it from the Desktop.'

/** True when the app's server isn't answering at all (as opposed to answering "no"). */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof ApiError) return error.status >= 502 && error.status <= 504
  return error instanceof TypeError
}

/** Field name -> message from a 422, e.g. `{ amount_paise: 'Amount must be…' }`. */
export function fieldErrors(error: unknown): Record<string, string> {
  return error instanceof ApiError ? error.fields : {}
}

/** One friendly sentence for a toast or a banner. */
export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.') {
  if (isUnreachable(error)) return UNREACHABLE_MESSAGE
  if (error instanceof ApiError) {
    if (error.status === 404) return 'This record no longer exists. It may have been deleted.'
    if (error.messages.length > 0) return error.message
  }
  return fallback
}
