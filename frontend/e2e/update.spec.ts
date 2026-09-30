/**
 * Updating from inside the app (ADR 0006), against the real server and a fake release feed
 * (e2e/fake-relay.mjs stands in for GitHub's "latest release").
 *
 * The server here runs from source, so it can't really update itself (it says so:
 * `not_installed`). The first test checks that for real, and the guards on starting an update.
 * The second pretends it's installed, fakes the start and the restart, and checks everything
 * the page does. A real update of a real install runs in CI's install jobs
 * (scripts/ci/smoke_in_app_update.py).
 */
import { expect, test, type APIRequestContext } from '@playwright/test'

const relay = `http://127.0.0.1:${process.env.E2E_RELAY_PORT}`
const APP_HEADERS = { 'Content-Type': 'application/json', 'X-Scrappy-Request': '1' }
const NOTES = "## What's new\n* **Faster** reports\n* See [the guide](https://example.com)"

async function publish(request: APIRequestContext, tag: string | null) {
  await request.post(`${relay}/feed`, { data: tag ? { tag, body: NOTES } : {} })
  const check = await request.post('/api/update/check', { headers: APP_HEADERS })
  expect(check.status()).toBe(200)
  return (await check.json()) as Record<string, unknown>
}

test.afterAll(async ({ request }) => {
  await publish(request, null) // nothing released again, for any test after these
})

test('the real server reads the feed, and only the app itself can start an update', async ({
  page,
  request,
}) => {
  const current = ((await (await request.get('/api/health')).json()) as { version: string }).version
  const info = await publish(request, 'v99.0.0')
  expect(info).toMatchObject({
    current,
    latest: '99.0.0',
    update_available: true,
    notes: "What's new\n• Faster reports\n• See the guide",
    can_update: false,
    reason: 'not_installed', // a copy running from source never updates itself
  })

  // Another website can't start it: no custom header, a form's content type, another origin.
  const start = (headers: Record<string, string>) =>
    request.post('/api/update/start', { data: JSON.stringify({ version: '99.0.0' }), headers })
  expect((await start({ 'Content-Type': 'application/json' })).status()).toBe(403)
  expect((await start({ ...APP_HEADERS, 'Content-Type': 'text/plain' })).status()).toBe(415)
  expect((await start({ ...APP_HEADERS, Origin: 'https://evil.example' })).status()).toBe(403)
  // The app's own request gets through the guards, and is told it can't update from here.
  const own = await start(APP_HEADERS)
  expect(own.status()).toBe(409)
  expect(((await own.json()) as { detail: string }).detail).toContain("can't update itself")

  // About says so in plain words, and Check for updates works.
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings' }).first().click()
  await page.getByRole('menuitem', { name: 'About' }).click()
  const about = page.getByRole('dialog', { name: 'About Scrappy Records' })
  await expect(about.getByTestId('update-status')).toHaveText(
    'Version 99.0.0 is ready to install. This copy can’t update itself (it isn’t an installed copy).',
  )
  await about.getByRole('button', { name: 'Check for updates' }).click()
  await expect(about.getByRole('button', { name: 'Check for updates' })).toBeEnabled()
  // No banner: it can't be installed from here.
  await expect(page.getByRole('region', { name: 'New version' })).toHaveCount(0)
})

test('banner → Update now → Updating… → the new version → reload', async ({ page, request }) => {
  const current = ((await (await request.get('/api/health')).json()) as { version: string }).version
  await publish(request, 'v99.0.0')
  const startedAt = new Date().toISOString()
  let phase: 'before' | 'started' | 'restarted' = 'before'
  let downPolls = 0
  const waitingFlags: string[] = []

  // Pretend this copy is installed; after the "restart", answer as the new version would.
  await page.route('**/api/update', async (route) => {
    const response = await route.fetch()
    const real = (await response.json()) as Record<string, unknown>
    const attempt = {
      from_version: current,
      to_version: '99.0.0',
      started_at: startedAt,
      finished_at: phase === 'restarted' ? new Date().toISOString() : null,
      outcome: phase === 'restarted' ? 'succeeded' : 'running',
      detail: '',
    }
    const json =
      phase === 'before'
        ? { ...real, can_update: true, reason: null }
        : phase === 'started'
          ? { ...real, can_update: false, reason: 'updating', last_attempt: attempt }
          : {
              ...real,
              current: '99.0.0',
              update_available: false,
              can_update: false,
              reason: 'up_to_date',
              notes: '',
              last_attempt: attempt,
            }
    await route.fulfill({ response, json })
  })
  const starts: { headers: Record<string, string>; body: unknown }[] = []
  await page.route('**/api/update/start', async (route) => {
    starts.push({ headers: route.request().headers(), body: route.request().postDataJSON() })
    phase = 'started'
    await route.fulfill({
      status: 202,
      json: {
        current,
        latest: '99.0.0',
        update_available: true,
        notes: '',
        checked_at: new Date().toISOString(),
        can_update: false,
        reason: 'updating',
        check_error: null,
        last_attempt: {
          from_version: current,
          to_version: '99.0.0',
          started_at: startedAt,
          finished_at: null,
          outcome: 'running',
          detail: '',
        },
        page_waiting: false,
        log_file: '/tmp/update.log',
      },
    })
  })
  // The server goes away for a moment (being replaced), then the new version answers.
  await page.route('**/api/health**', async (route) => {
    const url = new URL(route.request().url())
    if (phase === 'before') return route.continue()
    waitingFlags.push(url.searchParams.get('waiting_for_update') ?? '')
    if (phase === 'started' && downPolls < 2) {
      downPolls += 1
      return route.abort('connectionrefused')
    }
    phase = 'restarted'
    return route.fulfill({ json: { app: 'scrappy-records', version: '99.0.0', status: 'ok' } })
  })

  await page.goto('/')
  const banner = page.getByRole('region', { name: 'New version' })
  await expect(banner).toContainText('A new version (99.0.0) is ready.')
  await expect(page.getByTestId('update-dot').first()).toBeAttached()

  await banner.getByRole('button', { name: 'See what’s new' }).click()
  const notes = page.getByRole('dialog', { name: 'What’s new in version 99.0.0' })
  await expect(notes).toContainText('• Faster reports')
  await notes.getByRole('button', { name: 'Update now' }).click()

  const confirm = page.getByRole('dialog', { name: 'Update to version 99.0.0?' })
  await expect(confirm).toContainText(
    'Updating takes about a minute. Your records are kept and backed up first. The app will reopen by itself.',
  )
  await page.evaluate(() => {
    ;(window as unknown as { beforeUpdate: boolean }).beforeUpdate = true
  })
  await confirm.getByRole('button', { name: 'Update now' }).dblclick()
  await expect(page.getByText('Updating… the app will reopen in a minute')).toBeVisible()

  // The page reloads by itself once the new version answers, and says it's updated.
  await expect
    .poll(() => page.evaluate(() => 'beforeUpdate' in window), { timeout: 20_000 })
    .toBe(false)
  await expect(page.getByText('Updated to version 99.0.0.', { exact: false })).toBeVisible()
  await expect(page.getByTestId('updating-screen')).toHaveCount(0)

  expect(starts).toHaveLength(1) // a double click starts it once
  expect(starts[0]!.body).toEqual({ version: '99.0.0' })
  expect(starts[0]!.headers['x-scrappy-request']).toBe('1')
  expect(starts[0]!.headers['content-type']).toContain('application/json')
  // The polls told the server a page is waiting (so the launcher opens no second tab).
  expect(waitingFlags.length).toBeGreaterThanOrEqual(3)
  expect(waitingFlags.slice(0, 3)).toEqual(['true', 'true', 'true'])
})
