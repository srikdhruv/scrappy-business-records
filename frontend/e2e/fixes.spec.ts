/**
 * The fixes made before v0.1.0, end to end: coming back after leaving, fee changes already
 * scheduled, Enter after choosing how they paid, the Students search, the amount cap message
 * and the first click on "Paid on".
 */
import { expect, test } from '@playwright/test'

import {
  addMonths,
  changeFee,
  createStudent,
  formatMonth,
  monthRow,
  pay,
  paymentCount,
  pickMonth,
  serverMonth,
  uniqueName,
} from './helpers'

interface Detail {
  left_month: string | null
  owed_paise: number
  fee_history: { id: number; effective_month: string; amount_paise: number }[]
}

async function detail(request: import('@playwright/test').APIRequestContext, id: number) {
  return (await (await request.get(`/api/students/${id}`)).json()) as Detail
}

test('coming back after leaving asks the month, and the months away are never owed', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const [joined, last] = [addMonths(now, -4), addMonths(now, -3)]
  const name = uniqueName('Farhan')
  const id = await createStudent(request, {
    name,
    monthly_fee_paise: 150000,
    joined_month: joined,
    left_month: last,
  })
  await pay(request, { student_id: id, amount_paise: 150000, for_month: joined })
  await pay(request, { student_id: id, amount_paise: 150000, for_month: last })

  await page.goto(`/students/${id}`)
  await page.getByRole('button', { name: 'Mark as coming again' }).click()
  const dialog = page.getByRole('dialog', { name: `Mark ${name} as coming again?` })
  await expect(
    dialog.getByRole('button', { name: /^Which month are they back from\?:/ }),
  ).toContainText(formatMonth(now))
  await expect(dialog.getByText(/nothing is owed for the months away/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Mark as coming again' }).click()
  await expect(page.getByText(`${name} is coming again`)).toBeVisible()

  for (const away of [addMonths(now, -2), addMonths(now, -1)]) {
    await expect(monthRow(page, away).getByText('No fee')).toBeVisible()
    await expect(monthRow(page, away).getByText('Unpaid')).toHaveCount(0)
  }
  await expect(monthRow(page, now).getByText('Unpaid')).toBeVisible()
  const balance = page.getByRole('region', { name: 'Balance' })
  await expect(balance.getByText(/^Owes ₹1,500/)).toBeVisible()

  const d = await detail(request, id)
  expect(d.left_month).toBeNull()
  expect(d.owed_paise).toBe(150000)
  expect(d.fee_history.map((f) => [f.effective_month, f.amount_paise])).toEqual([
    [joined, 150000],
    [addMonths(last, 1), 0],
    [now, 150000],
  ])
})

test('a scheduled fee change shows in the message and can be removed from Fee history', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const later = addMonths(now, 2)
  const name = uniqueName('Leela')
  const id = await createStudent(request, {
    name,
    monthly_fee_paise: 150000,
    joined_month: addMonths(now, -1),
  })
  await changeFee(request, id, 180000, later)

  await page.goto(`/students/${id}`)
  // Edit: the new fee lasts only until the scheduled one starts.
  await page.getByRole('button', { name: 'Edit' }).click()
  const form = page.getByRole('dialog', { name: `Edit ${name}` })
  await form.getByLabel('Monthly fee').fill('2100')
  await expect(form.getByText(/they’ll owe ₹2,100 a month/)).toContainText(
    `until ${formatMonth(later)}, when ₹1,800 (already scheduled) starts.`,
  )
  await form.getByRole('button', { name: 'Cancel' }).click()

  // Fee history: remove the scheduled raise.
  const history = page.getByRole('list', { name: 'Fee history' })
  await expect(history.getByRole('listitem')).toHaveCount(2)
  await history
    .getByRole('button', { name: `Remove the fee change from ${formatMonth(later)}` })
    .click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText(`From ${formatMonth(later)} they’ll owe ₹1,500 a month.`)
  await confirm.getByRole('button', { name: 'Remove fee change' }).click()
  await expect(page.getByText('Fee change removed')).toBeVisible()
  await expect(history).toHaveCount(0)
  expect((await detail(request, id)).fee_history).toHaveLength(1)
})

test('a month off set in advance: no fee that month, then the usual fee again', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const off = addMonths(now, 2)
  const name = uniqueName('Tanya')
  const id = await createStudent(request, { name, monthly_fee_paise: 150000, joined_month: now })

  await page.goto(`/students/${id}`)
  const form = page.getByRole('dialog', { name: `Edit ${name}` })
  // Step 1: no fee from the month off.
  await page.getByRole('button', { name: 'Edit' }).click()
  await form.getByLabel('Monthly fee').fill('0')
  await pickMonth(page, 'New fee applies from', off)
  await form.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Changes saved')).toBeVisible()
  // Step 2: the usual fee from the month after. It's today's fee, and "applies from" still shows.
  await page.getByRole('button', { name: 'Edit' }).click()
  await form.getByLabel('Monthly fee').fill('1500')
  await pickMonth(page, 'New fee applies from', addMonths(off, 1))
  await expect(form.getByText(/they’ll owe ₹1,500 a month/)).toBeVisible()
  await form.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Changes saved')).toBeVisible()

  const fees = (await detail(request, id)).fee_history
  expect(fees.map((f) => [f.effective_month, f.amount_paise])).toEqual([
    [now, 150000],
    [off, 0],
    [addMonths(off, 1), 150000],
  ])
})

test('clicking Cash then pressing Enter saves exactly one payment', async ({ page, request }) => {
  const now = await serverMonth(request)
  const name = uniqueName('Charu')
  const id = await createStudent(request, { name, monthly_fee_paise: 130000, joined_month: now })

  await page.goto('/payments')
  await page.getByRole('button', { name: 'Log payment' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Log a payment' })
  await dialog.getByRole('combobox', { name: /^Student:/ }).focus()
  await page.keyboard.type(name)
  await page.getByRole('option', { name: new RegExp(name) }).click()
  await expect(dialog.getByLabel('Amount')).toHaveValue('1300')

  await dialog.getByRole('radio', { name: 'Cash' }).click()
  await expect(dialog.getByRole('radio', { name: 'Cash' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Payment saved')).toBeVisible()

  await page.waitForTimeout(500) // a second save would have landed by now
  expect(await paymentCount(request, id)).toBe(1)
  const [payment] = (await (await request.get(`/api/payments?student_id=${id}`)).json()) as {
    method: string
  }[]
  expect(payment?.method).toBe('cash')
})

test('Students search: phone without spaces, accents, and words in any order', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const suffix = uniqueName('x').split(' ').at(-1)!
  const name = `Émile ${suffix} Dsouza`
  const phone = `9${String(Date.now()).slice(-4)}${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`
  await createStudent(request, {
    name,
    monthly_fee_paise: 150000,
    joined_month: now,
    phone: `${phone.slice(0, 5)} ${phone.slice(5)}`,
  })

  await page.goto('/students')
  const search = page.getByRole('searchbox', { name: 'Search students' })
  const link = page.getByRole('link', { name })
  for (const typed of [phone, `emile ${suffix}`, `dsouza ${suffix} EMILE`]) {
    await search.fill(typed)
    await expect(link).toBeVisible()
    await expect(page.getByRole('table').getByRole('link')).toHaveCount(1)
  }
})

test('an amount over the cap written with "/-" says the cap', async ({ page }) => {
  await page.goto('/payments')
  await page.getByRole('button', { name: 'Log payment' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Log a payment' })
  await dialog.getByLabel('Amount').fill('₹20,00,000/-')
  await dialog.getByRole('button', { name: 'Save payment' }).click()
  await expect(dialog.getByText('The most you can enter is ₹10,00,000.')).toBeVisible()
})

test('the first click on "Paid on" shows the oldest payment first', async ({ page, request }) => {
  const now = await serverMonth(request)
  const id = await createStudent(request, {
    name: uniqueName('Sameer'),
    monthly_fee_paise: 100000,
    joined_month: now,
  })
  await pay(request, { student_id: id, amount_paise: 100000, for_month: now })

  await page.goto('/payments')
  const heading = page.getByRole('columnheader', { name: /Paid on/ })
  await expect(heading).toHaveAttribute('aria-sort', 'descending')
  await heading.getByRole('button').click()
  await expect(heading).toHaveAttribute('aria-sort', 'ascending')
})
