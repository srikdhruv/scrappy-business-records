/**
 * MSW request handlers: a stateful, in-memory version of every `/api` endpoint, answering with
 * the shapes in `src/api/schema.d.ts`. Used by `npm run dev:mock` (in the browser) and by the
 * Vitest suite (in Node). Never part of the production build.
 */
import { delay, http, HttpResponse, type JsonBodyType } from 'msw'

import type {
  FeedbackCreate,
  FeedbackRead,
  PaymentCreate,
  PaymentSort,
  PaymentUpdate,
  SortOrder,
  StudentCreate,
  StudentListFilter,
  StudentReturn,
  StudentUpdate,
} from '@/api/types'

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
  // Feedback: saved "on the laptop", then "sent" the first time anyone asks.
  const feedback = new Map<string, FeedbackRead>()

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

    http.post(api('/students/:id/return'), async ({ params, request }) => {
      await wait()
      const body = (await request.json()) as StudentReturn
      return respond(() => db.returnStudent(idParam(params.id), body))
    }),

    http.delete(api('/students/:id/fee-changes/:feeId'), async ({ params }) => {
      await wait()
      return respond(() => db.deleteFeeChange(idParam(params.id), idParam(params.feeId)), 204)
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

    http.get(api('/report'), async ({ request }) => {
      await wait()
      return respond(() => db.report(new URL(request.url).searchParams.get('month')))
    }),

    http.get(api('/about'), () =>
      HttpResponse.json({
        version: '0.1.0',
        build_id: '0000000000000000000000000000000000000000',
        data_dir: 'C:\\Users\\Demo\\AppData\\Local\\ScrappyRecords\\data',
        backup_dir: 'C:\\Users\\Demo\\Documents\\ScrappyRecords Backups',
        log_dir: 'C:\\Users\\Demo\\AppData\\Local\\ScrappyRecords\\logs',
        feedback_sending: true,
        feedback_waiting: [...feedback.values()].filter((f) => f.status === 'pending').length,
      }),
    ),

    http.post(api('/feedback'), async ({ request }) => {
      await wait()
      const body = (await request.json()) as FeedbackCreate
      if (!body.message?.trim()) {
        return HttpResponse.json(
          {
            detail: [
              { loc: ['body', 'message'], msg: 'Please write a message', type: 'value_error' },
            ],
          },
          { status: 422 },
        )
      }
      const id = body.id ?? crypto.randomUUID()
      const saved: FeedbackRead = feedback.get(id) ?? {
        id,
        category: body.category,
        status: 'pending',
        created_at: new Date().toISOString(),
        sent_at: null,
        attempts: 0,
        sending: true,
      }
      feedback.set(id, saved)
      return HttpResponse.json(saved, { status: 201 })
    }),

    http.get(api('/feedback/:id'), ({ params }) => {
      const found = feedback.get(String(params.id))
      if (!found) return HttpResponse.json({ detail: 'No feedback with that id' }, { status: 404 })
      const sent: FeedbackRead = {
        ...found,
        status: 'sent',
        sent_at: new Date().toISOString(),
        attempts: found.attempts + 1,
        sending: false,
      }
      feedback.set(sent.id, sent)
      return HttpResponse.json(sent)
    }),
  ]
}
