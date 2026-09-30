/**
 * Typed API client. Paths, params and bodies are checked against `schema.d.ts`, which is
 * generated from the backend (`make gen-api`) — never edit that file by hand.
 *
 *   const { data, error } = await api.GET('/api/students/{student_id}', {
 *     params: { path: { student_id: 1 } },
 *   })
 *
 * Use it inside TanStack Query hooks (see `queries.ts`); throw on `error` so queries fail.
 */
import createClient from 'openapi-fetch'

import type { paths } from './schema'

// Same origin: in dev Vite proxies /api to the backend; in production the backend serves the UI.
// (An absolute origin rather than '' because Node's Request, used in tests, needs one.)
// `fetch` is looked up per request (not captured once) so tests can stub it.
export const api = createClient<paths>({
  baseUrl: globalThis.location?.origin ?? '',
  fetch: (request) => globalThis.fetch(request),
})

interface ValidationItem {
  loc?: unknown[]
  msg?: unknown
}

/** Pydantic prefixes messages from custom validators with "Value error, ". */
function cleanMessage(msg: string): string {
  return msg.replace(/^Value error,\s*/, '')
}

/**
 * Turn FastAPI's `detail` into plain messages. `detail` is a string for 404s and similar, and a
 * list of `{loc, msg, type}` items for 422s (validation and business rules alike).
 */
export function errorMessages(detail: unknown): {
  messages: string[]
  fields: Record<string, string>
} {
  if (typeof detail === 'string') return { messages: [detail], fields: {} }
  const messages: string[] = []
  const fields: Record<string, string> = {}
  if (Array.isArray(detail)) {
    for (const item of detail as ValidationItem[]) {
      if (!item || typeof item.msg !== 'string') continue
      const msg = cleanMessage(item.msg)
      messages.push(msg)
      // loc is e.g. ["body", "left_month"]; a whole-body error has no field.
      const field = Array.isArray(item.loc) ? item.loc.slice(1).join('.') : ''
      if (field && !(field in fields)) fields[field] = msg
    }
  }
  return { messages, fields }
}

/**
 * An API error with the HTTP status, FastAPI's raw `detail`, and readable messages.
 * `message` is ready to show a person; `fields` maps a field name (e.g. "left_month") to its
 * message, for showing next to form inputs.
 */
export class ApiError extends Error {
  readonly status: number
  readonly detail: unknown
  readonly messages: string[]
  readonly fields: Record<string, string>

  constructor(status: number, detail: unknown) {
    const { messages, fields } = errorMessages(detail)
    super(messages.length > 0 ? messages.join('. ') : `Something went wrong (error ${status}).`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.messages = messages
    this.fields = fields
  }
}

/**
 * Unwrap an openapi-fetch result: return `data`, or throw an `ApiError`.
 *
 *   const student = unwrap(await api.GET('/api/students/{student_id}', { ... }))
 */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || !result.response.ok) {
    const detail =
      result.error && typeof result.error === 'object' && 'detail' in result.error
        ? (result.error as { detail: unknown }).detail
        : result.error
    throw new ApiError(result.response.status, detail)
  }
  return result.data as T
}
