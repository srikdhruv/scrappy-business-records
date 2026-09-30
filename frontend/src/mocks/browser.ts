/**
 * Starts the mock API in the browser (`npm run dev:mock` / `make dev-mock`). It's only imported
 * from `main.tsx` behind `import.meta.env.DEV`, so it is never part of the production build.
 *
 * Add `?demo=empty` to the URL to start with no students (the first-run screen), or
 * `?demo=all-paid` to start with everyone paid up, or `?demo=update` to see the "new version"
 * banner. The data lives in memory: reloading the page starts again from the demo data.
 */
import { setupWorker } from 'msw/browser'

import { MockDb } from './db'
import { allPaidFixture, demoFixture, emptyFixture } from './fixtures'
import { createHandlers } from './handlers'

export async function startMockApi(): Promise<void> {
  const demo = new URLSearchParams(window.location.search).get('demo')
  const fixture =
    demo === 'empty' ? emptyFixture() : demo === 'all-paid' ? allPaidFixture() : demoFixture()
  const db = new MockDb(fixture)
  const updateVersion = demo === 'update' ? '0.2.0' : undefined
  const worker = setupWorker(...createHandlers(db, { latency: 200, updateVersion }))
  await worker.start({ onUnhandledRequest: 'bypass', quiet: true })
  console.info('[Scrappy Records] Mock API with demo data (VITE_USE_MOCKS=true).')
}
