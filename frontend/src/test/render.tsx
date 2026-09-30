import { QueryClient } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router'

import type { Fixture } from '@/mocks/db'
import { demoFixture } from '@/mocks/fixtures'
import { mockDb } from '@/mocks/node'
import { Providers } from '@/providers'
import { routes } from '@/routes'

/** "Today" in the tests: 15 October 2026, so the current month is 2026-10. */
export const TEST_NOW = new Date(2026, 9, 15, 10, 0)

/**
 * Freeze the clock at TEST_NOW (only `Date`; timers stay real so user-event and TanStack Query
 * work normally) and load the mock API with `fixture` (default: the demo data).
 */
export function withMockApi(fixture: () => Fixture = () => demoFixture(TEST_NOW)) {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(TEST_NOW)
    mockDb.reset(fixture())
  })
  afterEach(() => {
    vi.useRealTimers()
  })
}

/** Render the whole app at `path`, with a fresh QueryClient that never retries. */
export function renderApp(path = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  const result = render(
    <Providers queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  )
  return { ...result, router, queryClient }
}

/** The open dialog (Log payment, student form, confirm). */
export async function findDialog(name?: string | RegExp) {
  const dialog = await screen.findByRole('dialog', name ? { name } : undefined)
  return within(dialog)
}

/** Stub `fetch` so `/api/*` calls answer with `body` (by path). Unknown paths answer 404. */
export function mockApi(responses: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost')
    if (url.pathname in responses) {
      return new Response(JSON.stringify(responses[url.pathname]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ detail: 'Not Found' }), { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}
