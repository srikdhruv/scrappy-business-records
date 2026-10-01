/**
 * Batches, end to end: the built UI, the real API and a real (temporary) SQLite database. See
 * playwright.config.ts. Other tests share the database, so each test makes its own batches
 * and students, with names no other test uses.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { createStudent, pay, serverMonth, uniqueName } from './helpers'

async function createBatch(
  request: APIRequestContext,
  body: { name: string; default_fee_paise?: number; location?: string; days?: string[] },
): Promise<number> {
  const response = await request.post('/api/batches', { data: body })
  expect(response.status(), await response.text()).toBe(201)
  return ((await response.json()) as { id: number }).id
}

const tabs = (page: Page) => page.getByRole('navigation', { name: 'Batches' })
const header = (page: Page) => page.locator('section[aria-labelledby="batch-heading"]')

async function choose(page: Page, label: string, option: string | RegExp) {
  await page.getByRole('combobox', { name: new RegExp(`^${label}:`) }).click()
  await page.getByRole('option', { name: option }).click()
}

test('create a batch, add a student from its tab with the fee filled in, and see % paid update', async ({
  page,
}) => {
  const batch = uniqueName('Evening')
  const name = uniqueName('Ishaan')

  await page.goto('/students')
  await page.getByRole('button', { name: 'New batch' }).first().click()
  const form = page.getByRole('dialog', { name: 'New batch' })
  await form.getByLabel('Name').fill(batch)
  await form.getByLabel(/Location/).fill('Koramangala')
  await form.getByRole('button', { name: 'Monday' }).click()
  await form.getByRole('button', { name: 'Wednesday' }).click()
  await form.getByLabel(/Starts at/).fill('17:00')
  await form.getByLabel(/Ends at/).fill('18:00')
  await form.getByLabel(/Usual monthly fee/).fill('1,800')
  await form.getByRole('button', { name: 'Add batch' }).click()
  await expect(page.getByText(`${batch} added`)).toBeVisible()

  // It opened the new batch's tab: a link, so the address says which batch.
  await expect(page).toHaveURL(/\/students\/batch\/\d+$/)
  await expect(page.getByRole('heading', { level: 2, name: batch })).toBeVisible()
  await expect(
    page.getByText('Koramangala · Mon, Wed · 5:00–6:00 pm · Usual fee ₹1,800'),
  ).toBeVisible()
  await expect(tabs(page).getByRole('link', { name: new RegExp(batch) })).toHaveAttribute(
    'aria-current',
    'page',
  )

  // + Add student: this batch chosen, its fee filled in.
  await page.getByRole('button', { name: 'Add student' }).first().click()
  const student = page.getByRole('dialog', { name: 'New student' })
  await expect(student.getByRole('combobox', { name: `Batch: ${batch}` })).toBeVisible()
  await expect(student.getByLabel('Monthly fee')).toHaveValue('1800')
  await student.getByLabel('Name').fill(name)
  await student.getByLabel('Name').press('Enter')
  await expect(page.getByText(`${name} added`)).toBeVisible()
  await expect(page.getByRole('table').getByRole('link', { name })).toBeVisible()
  await expect(header(page).getByText('0%')).toBeVisible()
  await expect(header(page).getByText('₹0 of ₹1,800 paid')).toBeVisible()

  // Log their payment (from the header): the batch's % paid follows.
  await page.getByRole('button', { name: 'Log payment' }).first().click()
  const log = page.getByRole('dialog', { name: 'Log a payment' })
  const picker = log.getByRole('combobox', { name: /Student/ })
  await picker.click()
  await page.getByPlaceholder('Type a name…').fill(name)
  // Each student shows their batch, so two with the same name can be told apart.
  await expect(page.getByRole('option', { name: new RegExp(`${name}.*${batch}`) })).toBeVisible()
  await page.getByRole('option', { name: new RegExp(name) }).click()
  await expect(log.getByLabel('Amount')).toHaveValue('1800')
  await log.getByRole('button', { name: 'Save payment' }).click()
  await expect(page.getByText('Payment saved')).toBeVisible()
  await expect(header(page).getByText('100%')).toBeVisible()
  await expect(header(page).getByText('₹1,800 of ₹1,800 paid')).toBeVisible()

  // Back on All batches, the card says the same.
  await tabs(page)
    .getByRole('link', { name: /^All batches/ })
    .click()
  const card = page.getByRole('article', { name: batch })
  await expect(card.getByText('100%')).toBeVisible()
  await expect(card.getByText('Mon, Wed · 5:00–6:00 pm')).toBeVisible()
  // Back returns to the batch.
  await page.goBack()
  await expect(page.getByRole('heading', { level: 2, name: batch })).toBeVisible()
})

test('filter and group every student on the All batches tab', async ({ page, request }) => {
  const now = await serverMonth(request)
  const place = uniqueName('Studio')
  const sat = uniqueName('Saturday')
  const sun = uniqueName('Sunday')
  const satId = await createBatch(request, { name: sat, location: place, days: ['sat'] })
  const sunId = await createBatch(request, { name: sun, location: place, days: ['sun'] })
  const [a, b] = [uniqueName('Asha'), uniqueName('Bela')]
  for (const [name, batch_id] of [
    [a, satId],
    [b, sunId],
  ] as const) {
    const response = await request.post('/api/students', {
      data: { name, monthly_fee_paise: 100000, joined_month: now, batch_id },
    })
    expect(response.status()).toBe(201)
  }

  await page.goto('/students')
  const table = page.getByRole('table')
  await choose(page, 'Location', place)
  await expect(table.getByRole('link', { name: a })).toBeVisible()
  await expect(table.getByRole('link', { name: b })).toBeVisible()
  await expect(table.getByRole('row')).toHaveCount(3)

  await choose(page, 'Group by', 'Batch')
  await expect(table.getByRole('heading', { name: sat })).toBeVisible()
  await expect(table.getByRole('heading', { name: sun })).toBeVisible()

  await choose(page, 'Day', 'Sunday')
  await expect(table.getByRole('link', { name: b })).toBeVisible()
  await expect(table.getByRole('link', { name: a })).toHaveCount(0)
  await expect(table.getByRole('heading', { name: sat })).toHaveCount(0)

  // Typing jumps straight to a match; Enter opens it.
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await page.getByRole('searchbox', { name: 'Search students' }).fill(a)
  await page.getByRole('searchbox', { name: 'Search students' }).press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: a })).toBeVisible()
  // The profile links to the batch's tab.
  await page.getByRole('link', { name: sat }).first().click()
  await expect(page).toHaveURL(new RegExp(`/students/batch/${satId}$`))
})

test('delete a batch: its students move to No batch', async ({ page, request }) => {
  const now = await serverMonth(request)
  const batch = uniqueName('Trial')
  const id = await createBatch(request, { name: batch })
  const name = uniqueName('Kiran')
  const response = await request.post('/api/students', {
    data: { name, monthly_fee_paise: 120000, joined_month: now, batch_id: id },
  })
  const studentId = ((await response.json()) as { id: number }).id
  await pay(request, { student_id: studentId, amount_paise: 120000, for_month: now })

  await page.goto(`/students/batch/${id}`)
  await page.getByRole('button', { name: `Delete ${batch}` }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('Its 1 student isn’t deleted: they move to No batch.')
  await confirm.getByRole('button', { name: 'Delete batch' }).click()
  await expect(page).toHaveURL(/\/students$/)
  await expect(page.getByText(`${batch} deleted`)).toBeVisible()
  await expect(tabs(page).getByRole('link', { name: new RegExp(batch) })).toHaveCount(0)

  await tabs(page)
    .getByRole('link', { name: /^No batch/ })
    .click()
  await expect(page).toHaveURL(/\/students\/batch\/none$/)
  await expect(page.getByRole('table').getByRole('link', { name })).toBeVisible()
  // Nothing of theirs was lost.
  const detail = (await (await request.get(`/api/students/${studentId}`)).json()) as {
    batch_id: number | null
    payment_count: number
  }
  expect(detail).toMatchObject({ batch_id: null, payment_count: 1 })
})

test('create batches from existing labels', async ({ page, request }) => {
  const now = await serverMonth(request)
  const label = uniqueName('Thu 7pm')
  const names = [uniqueName('Ravi'), uniqueName('Leela'), uniqueName('Mohan')]
  const spellings = [label, label.toUpperCase(), `  ${label.replace(' ', '   ')} `]
  for (const [i, name] of names.entries()) {
    await createStudent(request, { name, monthly_fee_paise: 150000, joined_month: now })
    const students = (await (await request.get('/api/students?status=all')).json()) as {
      id: number
      name: string
    }[]
    const id = students.find((s) => s.name === name)!.id
    await request.patch(`/api/students/${id}`, { data: { batch_label: spellings[i] } })
  }

  await page.goto('/students')
  await page.getByRole('button', { name: 'Create batches from existing labels' }).click()
  const dialog = page.getByRole('dialog', { name: 'Create batches from existing labels' })
  const group = dialog.getByRole('listitem').filter({ hasText: label })
  await expect(group).toContainText('3 students')
  for (const name of names) await expect(group).toContainText(name)
  await dialog.getByRole('button', { name: /^Create \d+ batch/ }).click()
  await expect(page.getByText(/created/)).toBeVisible()
  await expect(page.getByText('A backup was saved first.', { exact: false })).toBeVisible()

  // One batch, all three in it, labels kept as typed.
  const batches = (await (await request.get('/api/batches')).json()) as {
    id: number
    name: string
    student_count: number
  }[]
  const made = batches.find((b) => b.name === label)!
  expect(made.student_count).toBe(3)
  await tabs(page)
    .getByRole('link', { name: new RegExp(label) })
    .click()
  for (const name of names)
    await expect(page.getByRole('table').getByRole('link', { name })).toBeVisible()
})

test('with 12 batches on a 1280×800 window, what is typed and its match are in view', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const now = await serverMonth(request)
  const tag = uniqueName('Batch')
  const ids: number[] = []
  for (let i = 1; i <= 12; i++) ids.push(await createBatch(request, { name: `${tag} ${i}` }))
  const name = uniqueName('Zoya')
  const response = await request.post('/api/students', {
    data: { name, monthly_fee_paise: 120000, joined_month: now, batch_id: ids[11] },
  })
  expect(response.status()).toBe(201)

  await page.goto('/students')
  const search = page.getByRole('searchbox', { name: 'Search students' })
  await expect(search).toBeFocused()
  await expect(search).toBeInViewport()
  await page.keyboard.type(name)
  // The batch cards fold away, so the match is right under the search box.
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name }) })
  await expect(row).toBeInViewport()
  await expect(row).toHaveAttribute('data-next', 'true')
  await expect(row.getByText('Enter opens')).toBeVisible()
  await search.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
})

test('tick students and move them to a batch at once; their fees stay', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const batch = uniqueName('Move')
  const id = await createBatch(request, { name: batch })
  const names = [uniqueName('Ira'), uniqueName('Jai')]
  for (const name of names) {
    await createStudent(request, { name, monthly_fee_paise: 110000, joined_month: now })
  }

  await page.goto('/students/batch/none')
  for (const name of names) await page.getByRole('checkbox', { name: `Tick ${name}` }).check()
  await expect(page.getByText('2 students ticked')).toBeVisible()
  await page.getByRole('button', { name: 'Move to batch…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Move 2 students to a batch' })
  await dialog.getByRole('combobox', { name: /^Batch:/ }).click()
  await page.getByPlaceholder('Type a batch, place or day…').fill(batch)
  await page.getByRole('option', { name: new RegExp(batch) }).click()
  await dialog.getByRole('button', { name: `Move to ${batch}` }).click()
  await expect(page.getByText(`2 students moved to ${batch}`)).toBeVisible()

  const students = (await (await request.get('/api/students?status=all')).json()) as {
    name: string
    batch_id: number | null
    monthly_fee_paise: number
  }[]
  for (const name of names) {
    expect(students.find((s) => s.name === name)).toMatchObject({
      batch_id: id,
      monthly_fee_paise: 110000,
    })
  }
})
