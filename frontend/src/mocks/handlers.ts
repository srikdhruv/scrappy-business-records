/**
 * MSW request handlers: a stateful, in-memory version of every `/api` endpoint, answering with
 * the shapes in `src/api/schema.d.ts`. Used by `npm run dev:mock` (in the browser) and by the
 * Vitest suite (in Node). Never part of the production build.
 */
import { delay, http, HttpResponse, type JsonBodyType } from 'msw'

import type {
  PaymentCreate,
  PaymentSort,
  PaymentUpdate,
  SortOrder,
  StudentCreate,
  StudentListFilter,
  StudentUpdate,
} from '@/api/schema'

import { MockHttpError, type MockDb } from './db'

/** Matches `/api/...` on any origin (the dev server, or jsdom's in tests). */
const api = (path: string) => `*/api${path}`

function respond(fn: () => unknown, status = 200) {
  try {
    const body = fn()
    if (status === 204) return new HttpResponse(null, { status })
    return HttpResponse.json((body ?? null) as JsonBodyType, { status })
  } catch (error) {
    if (error instanceof MockHttpError) {
      return HttpResponse.json(error.body as JsonBodyType, { status: error.status })
    }
    throw error
  }
}

function idParam(value: string | readonly string[] | undefined): number {
  return Number(Array.isArray(value) ? value[0] : value)
}

export interface HandlerOptions {
  /** Simulated network latency in ms, so loading states are visible in the browser. */
  latency?: number
}

export function createHandlers(db: MockDb, { latency = 0 }: HandlerOptions = {}) {
  const wait = async () => {
    if (latency > 0) await delay(latency)
  }

  return [
    http.get(api('/health'), () =>
      HttpResponse.json({ app: 'scrappy-records', version: '0.1.0', status: 'ok' }),
    ),

    http.get(api('/students'), async ({ request }) => {
      await wait()
      const url = new URL(request.url)
      const status = (url.searchParams.get('status') ?? 'active') as StudentListFilter
      return respond(() => db.listStudents(status, url.searchParams.get('q')))
    }),

    http.post(api('/students'), async ({ request }) => {
      await wait()
      const body = (await request.json()) as StudentCreate
      return respond(() => db.createStudent(body), 201)
    }),

    http.get(api('/students/:id/suggest-payment'), async ({ params }) => {
      await wait()
      return respond(() => db.suggestPayment(idParam(params.id)))
    }),

    http.get(api('/students/:id'), async ({ params }) => {
      await wait()
      return respond(() => db.getStudent(idParam(params.id)))
    }),

    http.patch(api('/students/:id'), async ({ params, request }) => {
      await wait()
      const body = (await request.json()) as StudentUpdate
      return respond(() => db.updateStudent(idParam(params.id), body))
    }),

    http.delete(api('/students/:id'), async ({ params }) => {
      await wait()
      return respond(() => db.deleteStudent(idParam(params.id)), 204)
    }),

    http.get(api('/payments'), async ({ request }) => {
      await wait()
      const search = new URL(request.url).searchParams
      const studentId = search.get('student_id')
      return respond(() =>
        db.listPayments({
          student_id: studentId ? Number(studentId) : null,
          month: search.get('month'),
          q: search.get('q'),
          sort: (search.get('sort') ?? undefined) as PaymentSort | undefined,
          order: (search.get('order') ?? undefined) as SortOrder | undefined,
        }),
      )
    }),

    http.post(api('/payments'), async ({ request }) => {
      await wait()
      const body = (await request.json()) as PaymentCreate
      return respond(() => db.createPayment(body), 201)
    }),

    http.get(api('/payments/:id'), async ({ params }) => {
      await wait()
      return respond(() => db.getPayment(idParam(params.id)))
    }),

    http.patch(api('/payments/:id'), async ({ params, request }) => {
      await wait()
      const body = (await request.json()) as PaymentUpdate
      return respond(() => db.updatePayment(idParam(params.id), body))
    }),

    http.delete(api('/payments/:id'), async ({ params }) => {
      await wait()
      return respond(() => db.deletePayment(idParam(params.id)), 204)
    }),

    http.get(api('/dashboard'), async ({ request }) => {
      await wait()
      return respond(() => db.dashboard(new URL(request.url).searchParams.get('month')))
    }),
  ]
}
