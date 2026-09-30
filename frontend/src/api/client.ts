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

/** An API error with the HTTP status and FastAPI's `detail`. */
export class ApiError extends Error {
  readonly status: number
  readonly detail: unknown

  constructor(status: number, detail: unknown) {
    super(typeof detail === 'string' ? detail : `Request failed (${status})`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
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
