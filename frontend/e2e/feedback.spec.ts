/**
 * Settings → Send feedback, against the real server and a fake relay (e2e/fake-relay.mjs): the
 * picture is taken, the server saves the feedback and sends it on, and the dialog says so.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { createStudent, serverMonth, uniqueName } from './helpers'

const relay = `http://127.0.0.1:${process.env.E2E_RELAY_PORT}`

interface Received {
  id: string
  category: string
  message: string
  app_version: string
  build_id: string
  route: string
  created_at: string
  local_time: string
  environment: Record<string, string>
  log_tail: string
  screenshot: { content_type: string; data_base64: string } | null
}

async function received(request: APIRequestContext): Promise<Received[]> {
  return (await (await request.get(`${relay}/received`)).json()) as Received[]
}

async function openFeedback(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'Send feedback' }).click()
  const dialog = page.getByRole('dialog', { name: 'Send feedback' })
  await expect(dialog.getByRole('img', { name: 'Picture of this screen' })).toBeVisible()
  return dialog
}

test('send feedback with a picture of the screen: it reaches the relay', async ({
  page,
  request,
}) => {
  const month = await serverMonth(request)
  await createStudent(request, {
    name: uniqueName('Kabir'),
    monthly_fee_paise: 150000,
    joined_month: month,
  })
  const health = (await (await request.get('/api/health')).json()) as { version: string }
  const about = (await (await request.get('/api/about')).json()) as { build_id: string }
  const before = (await received(request)).length

  await page.goto(`/payments?month=${month}`)
  await expect(page.getByRole('heading', { name: 'Payments' })).toBeVisible()
  const dialog = await openFeedback(page)
  await dialog.getByRole('radio', { name: 'Problem' }).click()
  const message = `The total looks wrong ${uniqueName('e2e')}`
  await dialog.getByLabel('Message').fill(message)
  await dialog.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Sent ✓')).toBeVisible({ timeout: 20_000 })

  const sent = (await received(request)).slice(before)
  expect(sent).toHaveLength(1)
  const [feedback] = sent
  expect(feedback!.message).toBe(message)
  expect(feedback!.category).toBe('problem')
  expect(feedback!.route).toBe('/payments') // the path only, never the query
  expect(feedback!.app_version).toBe(health.version)
  expect(feedback!.build_id).toBe(about.build_id)
  expect(feedback!.build_id).toMatch(/^[0-9a-f]{40}(-dirty)?$|^unknown$/)
  expect(feedback!.created_at).toMatch(/Z$/)
  expect(feedback!.local_time).toMatch(/[+-]\d\d:\d\d$/)
  expect(feedback!.environment.browser).toContain('Chrome')
  expect(feedback!.screenshot?.content_type).toBe('image/jpeg')
  const picture = Buffer.from(feedback!.screenshot!.data_base64, 'base64')
  expect(picture.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
  expect(picture.length).toBeGreaterThan(5_000)
  expect(picture.length).toBeLessThanOrEqual(700_000)

  // The server keeps it as sent.
  const status = await request.get(`/api/feedback/${feedback!.id}`)
  expect(((await status.json()) as { status: string }).status).toBe('sent')
})

test('offline: the dialog says Saved, and it goes later by itself', async ({ page, request }) => {
  await request.post(`${relay}/script`, {
    data: [{ status: 503, body: { status: 'upstream_error', error: 'GitHub is down' } }],
  })
  await page.goto('/')
  const dialog = await openFeedback(page)
  await dialog.getByRole('radio', { name: 'Question' }).click()
  await dialog.getByLabel('Message').fill('Is my data backed up?')
  await dialog.getByRole('checkbox', { name: 'Include a picture of this screen' }).uncheck()
  await dialog.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('it’ll be sent automatically when you’re online')).toBeVisible({
    timeout: 20_000,
  })
  const [last] = (await received(request)).slice(-1)
  expect(last!.message).toBe('Is my data backed up?')
  expect(last!.screenshot).toBeNull()
  const saved = (await (await request.get(`/api/feedback/${last!.id}`)).json()) as {
    status: string
    attempts: number
  }
  expect(saved).toMatchObject({ status: 'pending', attempts: 1 })
  // About says one is waiting.
  await page.getByRole('button', { name: 'Close' }).last().click()
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByRole('menuitem', { name: 'About' }).click()
  await expect(page.getByText('1 message waiting to be sent.', { exact: false })).toBeVisible()
})

/** How different two pictures look (0 = the same), compared small, in the browser. */
async function difference(page: Page, a: string, b: string): Promise<number> {
  return page.evaluate(
    async ([a, b]) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = reject
          img.src = src
        })
      const [first, second] = await Promise.all([load(a), load(b)])
      const [w, h] = [160, 100]
      const pixels = (img: HTMLImageElement) => {
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const context = canvas.getContext('2d')!
        context.drawImage(img, 0, 0, w, h)
        return context.getImageData(0, 0, w, h).data
      }
      const [pa, pb] = [pixels(first), pixels(second)]
      let sum = 0
      for (let i = 0; i < pa.length; i += 4) {
        sum += Math.abs(pa[i]! - pb[i]!) + Math.abs(pa[i + 1]! - pb[i + 1]!)
        sum += Math.abs(pa[i + 2]! - pb[i + 2]!)
      }
      return sum / (w * h * 3)
    },
    [a, b] as const,
  )
}

test('on a very long page, the picture is exactly the screen: top, middle and bottom', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000)
  const month = await serverMonth(request)
  // 450 students: the Students page is far taller than a browser can draw in one picture.
  const ids: number[] = []
  const names = Array.from({ length: 450 }, (_, i) => uniqueName(`Tall${i}`))
  for (let i = 0; i < names.length; i += 30) {
    const batch = names.slice(i, i + 30)
    ids.push(
      ...(await Promise.all(
        batch.map((name) =>
          createStudent(request, { name, monthly_fee_paise: 150000, joined_month: month }),
        ),
      )),
    )
  }
  try {
    await page.goto('/students')
    await expect(page.getByRole('link', { name: names[0]! })).toBeVisible({ timeout: 30_000 })
    const tall = await page.evaluate(() => document.documentElement.scrollHeight)
    expect(tall).toBeGreaterThan(16_384)

    const shots: Record<string, { screen: string; picture: string }> = {}
    const places = [
      ['top', 0],
      ['middle', Math.round(tall / 2)],
      ['bottom', tall],
    ] as const
    for (const [where, y] of places) {
      await page.evaluate((top) => window.scrollTo(0, top), y)
      await page.waitForTimeout(400)
      const screen = `data:image/png;base64,${(await page.screenshot()).toString('base64')}`
      const dialog = await openFeedback(page)
      const picture = await dialog
        .getByRole('img', { name: 'Picture of this screen' })
        .getAttribute('src')
      const size = await page.evaluate(async (src) => {
        const img = new Image()
        img.src = src
        await img.decode()
        return { width: img.naturalWidth, height: img.naturalHeight }
      }, picture!)
      // The window's size (less a scroll bar), never a squashed whole page.
      expect(size.height, where).toBe(900)
      expect(size.width, where).toBeGreaterThan(1200)
      shots[where] = { screen, picture: picture! }
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0)
    }
    // Each picture looks like its own screen, and not like the others.
    const report: string[] = []
    for (const [where] of places) {
      const own = await difference(page, shots[where]!.screen, shots[where]!.picture)
      report.push(`${where}: ${own.toFixed(2)}`)
      expect(own, `${where} vs its screen`).toBeLessThan(3)
      for (const [other] of places.filter(([o]) => o !== where)) {
        const wrong = await difference(page, shots[other]!.screen, shots[where]!.picture)
        report.push(`${where} vs ${other}: ${wrong.toFixed(2)}`)
        expect(wrong, `${where} vs the ${other} screen`).toBeGreaterThan(Math.max(4, own * 3))
      }
    }
    console.log(report.join(', '))
  } finally {
    for (let i = 0; i < ids.length; i += 30) {
      await Promise.all(ids.slice(i, i + 30).map((id) => request.delete(`/api/students/${id}`)))
    }
  }
})
