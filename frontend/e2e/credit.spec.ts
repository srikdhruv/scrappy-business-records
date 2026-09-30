/**
 * Extra money covers unpaid months (PRD ledger rule 10), end to end: the built UI, the real API
 * and a real (temporary) SQLite database. See playwright.config.ts.
 */
import { expect, test } from '@playwright/test'

import { formatDate, today } from '../src/lib/format'
import {
  addMonths,
  createStudent,
  formatMonth,
  monthRow,
  panel,
  pay,
  serverMonth,
  uniqueName,
} from './helpers'

const MONTH_SHORT = (month: string) => {
  const [name, year] = formatMonth(month).split(' ')
  return `${name!.slice(0, 3)} ${year}`
}

test('the real case: this month paid double while last month was unpaid', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const [first, missed] = [addMonths(now, -2), addMonths(now, -1)]
  const name = uniqueName('Tara')
  const id = await createStudent(request, {
    name,
    monthly_fee_paise: 150000,
    joined_month: first,
  })
  await pay(request, { student_id: id, amount_paise: 150000, for_month: first })

  // Before: last month is owed.
  await page.goto('/')
  const earlier = panel(page, /Earlier months still owed/)
  await expect(earlier.getByRole('link', { name: new RegExp(name) })).toBeVisible()

  // Log ₹3,000 for this month from "Yet to pay": the form says where the extra will go.
  await panel(page, /Yet to pay/)
    .getByRole('button', { name: `Log payment for ${name}` })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Log a payment' })
  await expect(dialog.getByLabel(/^For month:/)).toHaveText(formatMonth(now))
  await dialog.getByLabel('Amount').fill('3000')
  await expect(
    dialog.getByText(
      `₹1,500 more than the ${formatMonth(now).split(' ')[0]} fee: it will pay ${formatMonth(missed)} (unpaid).`,
    ),
  ).toBeVisible()
  await dialog.getByRole('button', { name: 'Save payment' }).click()
  await expect(page.getByText('Payment saved')).toBeVisible()

  // The dashboard: nothing owed from last month, not in Yet to pay, and the move is listed.
  await expect(panel(page, /Yet to pay/).getByRole('link', { name })).toHaveCount(0)
  await expect(earlier.getByRole('link', { name: new RegExp(name) })).toHaveCount(0)
  const used = panel(page, /Extra money used/).getByRole('link', { name: new RegExp(name) })
  await expect(used).toContainText(
    `₹1,500 extra from the ${formatDate(today())} payment for ${MONTH_SHORT(now)}`,
  )
  await expect(used).toContainText(MONTH_SHORT(missed))

  // The profile: last month paid with credit, and this month says where its extra went.
  await used.click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Balance' }).getByText('Up to date')).toBeVisible()
  await expect(monthRow(page, missed).getByText('Paid', { exact: true })).toBeVisible()
  await expect(monthRow(page, missed).getByText('₹1,500 (credit)')).toBeVisible()
  await expect(
    monthRow(page, missed).getByText(
      `₹1,500 credit from the ${formatDate(today())} payment (for ${MONTH_SHORT(now)})`,
    ),
  ).toBeVisible()
  await expect(monthRow(page, now).getByText(`₹1,500 extra → ${MONTH_SHORT(missed)}`)).toBeVisible()

  // The Payments page says where the money went.
  await page.goto('/payments')
  await page.getByPlaceholder('Search names and notes').fill(name)
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name }) })
  await expect(row.filter({ hasText: '₹3,000' })).toContainText(
    `₹1,500 went to ${MONTH_SHORT(missed)}`,
  )

  // Editing that payment down to one fee makes last month owed again, straight away.
  await row
    .filter({ hasText: '₹3,000' })
    .getByRole('button', { name: /^Edit payment/ })
    .click()
  const edit = page.getByRole('dialog', { name: 'Edit payment' })
  await expect(edit.getByText(`Now: ₹1,500 went to ${MONTH_SHORT(missed)}.`)).toBeVisible()
  await edit.getByLabel('Amount').fill('1500')
  await expect(edit.getByText(/it will pay/)).toHaveCount(0)
  await edit.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Payment updated')).toBeVisible()
  await page.goto(`/students/${id}`)
  await expect(monthRow(page, missed).getByText('Unpaid')).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Balance' }).getByText(/^Owes ₹1,500/),
  ).toBeVisible()
})

test('money no month needs is kept as credit, and listed on the dashboard', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const last = addMonths(now, -1)
  const name = uniqueName('Yash')
  const id = await createStudent(request, {
    name,
    monthly_fee_paise: 100000,
    joined_month: last,
    left_month: last,
  })
  await pay(request, { student_id: id, amount_paise: 150000, for_month: last })

  await page.goto(`/students/${id}`)
  const balance = page.getByRole('region', { name: 'Balance' })
  await expect(balance.getByText('Credit ₹500')).toBeVisible()
  await expect(balance.getByText('₹500 kept as credit')).toBeVisible()

  await page.goto('/')
  await expect(
    panel(page, /Extra kept as credit/).getByRole('link', { name: new RegExp(name) }),
  ).toContainText('+₹500')
})
