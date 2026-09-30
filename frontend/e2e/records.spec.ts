/**
 * The owner's everyday flows, end to end: the built UI, the real API and a real (temporary)
 * SQLite database. See playwright.config.ts.
 */
import { expect, test } from '@playwright/test'

import {
  addMonths,
  changeFee,
  createStudent,
  formatMonth,
  formatRupees,
  monthRow,
  panel,
  pay,
  paymentCount,
  pickMonth,
  serverMonth,
  stillDue,
  uniqueName,
} from './helpers'

const MONTH_SHORT = (month: string) => {
  const [name, year] = formatMonth(month).split(' ')
  return `${name!.slice(0, 3)} ${year}`
}

test('add a student, see them in Yet to pay, log their payment, and the dashboard updates', async ({
  page,
}) => {
  const name = uniqueName('Ishaan')

  await page.goto('/students')
  await page.getByRole('button', { name: 'New student' }).first().click()
  const form = page.getByRole('dialog', { name: 'New student' })
  await form.getByLabel('Name').fill(name)
  await form.getByLabel('Monthly fee').fill('1,500')
  await form.getByLabel('Monthly fee').press('Enter')
  await expect(page.getByText(`${name} added`)).toBeVisible()
  await expect(page.getByRole('link', { name })).toBeVisible()

  await page.getByRole('link', { name: 'Dashboard' }).click()
  const yetToPay = panel(page, /Yet to pay/)
  await expect(yetToPay.getByRole('link', { name })).toBeVisible()
  const stillDueBefore = await stillDue(page)

  await yetToPay.getByRole('button', { name: `Log payment for ${name}` }).click()
  const dialog = page.getByRole('dialog', { name: 'Log a payment' })
  await expect(dialog.getByLabel('Amount')).toBeFocused()
  await expect(dialog.getByLabel('Amount')).toHaveValue('1500')
  await page.keyboard.press('Enter')

  await expect(page.getByText('Payment saved')).toBeVisible()
  await expect(yetToPay.getByRole('link', { name })).toHaveCount(0)
  // Exactly ₹1,500 less is still due.
  await expect.poll(() => stillDue(page)).toBe(stillDueBefore - 150000)
  await expect(
    page.getByRole('group', { name: 'Summary' }).getByText(formatRupees(stillDueBefore - 150000)),
  ).toBeVisible()
  // Screen reader users land on the list's heading, not lost on the page.
  await expect(page.getByRole('heading', { name: /Yet to pay/ })).toBeFocused()
})

test('moving a payment to another month changes the profile’s month-by-month', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const last = addMonths(now, -1)
  const name = uniqueName('Meher')
  const id = await createStudent(request, { name, monthly_fee_paise: 150000, joined_month: last })
  await pay(request, { student_id: id, amount_paise: 150000, for_month: last })

  await page.goto(`/students/${id}`)
  await expect(monthRow(page, last).getByText('Paid')).toBeVisible()
  await expect(monthRow(page, now).getByText('Unpaid')).toBeVisible()

  await panel(page, /^Payments/)
    .getByRole('button', { name: /^Edit payment/ })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Edit payment' })
  await pickMonth(page, 'For month', now)
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Payment updated')).toBeVisible()

  await expect(monthRow(page, now).getByText('Paid')).toBeVisible()
  await expect(monthRow(page, last).getByText('Unpaid')).toBeVisible()
})

test('a new fee applies from the chosen month; earlier months keep the old fee', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const start = addMonths(now, -2)
  const from = addMonths(now, -1)
  const name = uniqueName('Nivedita')
  const id = await createStudent(request, { name, monthly_fee_paise: 150000, joined_month: start })

  await page.goto(`/students/${id}`)
  await page.getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: `Edit ${name}` })
  await dialog.getByLabel('Monthly fee').fill('1800')
  await expect(dialog.getByRole('button', { name: /^New fee applies from:/ })).toContainText(
    formatMonth(now),
  )
  await pickMonth(page, 'New fee applies from', from)
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(page.getByText('Changes saved')).toBeVisible()

  await expect(monthRow(page, start).getByRole('cell').nth(1)).toHaveText('₹1,500')
  await expect(monthRow(page, from).getByRole('cell').nth(1)).toHaveText('₹1,800')
  await expect(monthRow(page, now).getByRole('cell').nth(1)).toHaveText('₹1,800')
  await expect(page.getByText(`₹1,500 from ${MONTH_SHORT(start)}`)).toBeVisible()
})

test('mark as left moves the student to the Left tab', async ({ page, request }) => {
  const now = await serverMonth(request)
  const name = uniqueName('Omkar')
  const id = await createStudent(request, {
    name,
    monthly_fee_paise: 120000,
    joined_month: addMonths(now, -3),
  })

  await page.goto(`/students/${id}`)
  await page.getByRole('button', { name: 'Mark as left' }).click()
  const dialog = page.getByRole('dialog', { name: `Mark ${name} as left?` })
  await pickMonth(page, 'Last month they should pay for', addMonths(now, -1))
  await dialog.getByRole('button', { name: 'Mark as left' }).click()
  await expect(
    page.getByText(`Left after ${formatMonth(addMonths(now, -1))}`, { exact: true }),
  ).toBeVisible()

  await page.goto('/students')
  await expect(page.getByRole('tab', { name: /Active/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('link', { name })).toHaveCount(0)
  await page.getByRole('tab', { name: /Left/ }).click()
  await expect(page.getByRole('link', { name })).toBeVisible()
})

test('money paid too much is shown as extra; paying early is "paid ahead"', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const last = addMonths(now, -1)

  // Paid ₹1,500 for last month's ₹1,000 fee, and nothing yet this month.
  const extra = uniqueName('Pranav')
  const extraId = await createStudent(request, {
    name: extra,
    monthly_fee_paise: 100000,
    joined_month: last,
  })
  await pay(request, { student_id: extraId, amount_paise: 150000, for_month: last })

  // Paid this month and next month already.
  const ahead = uniqueName('Rhea')
  const aheadId = await createStudent(request, {
    name: ahead,
    monthly_fee_paise: 100000,
    joined_month: now,
  })
  await pay(request, { student_id: aheadId, amount_paise: 100000, for_month: now })
  await pay(request, { student_id: aheadId, amount_paise: 100000, for_month: addMonths(now, 1) })

  await page.goto('/')
  await expect(
    panel(page, /Yet to pay/).getByText(`Paid ₹500 extra in ${MONTH_SHORT(last)}`),
  ).toBeVisible()

  await page.goto('/students')
  const extraRow = page.getByRole('row').filter({ has: page.getByRole('link', { name: extra }) })
  // This month's ₹1,000 is owed in full: last month's extra ₹500 doesn't cancel it out.
  await expect(extraRow.getByText('Owes ₹1,000')).toBeVisible()
  await expect(extraRow.getByText('₹500 paid extra')).toBeVisible()
  const aheadRow = page.getByRole('row').filter({ has: page.getByRole('link', { name: ahead }) })
  await expect(aheadRow.getByText('Up to date')).toBeVisible()
  await expect(aheadRow.getByText('Paid ahead ₹1,000')).toBeVisible()

  await page.goto(`/students/${aheadId}`)
  const balance = page.getByRole('region', { name: 'Balance' })
  await expect(balance.getByText('Up to date')).toBeVisible()
  await expect(balance.getByText(`Paid ahead to ${MONTH_SHORT(addMonths(now, 1))}`)).toBeVisible()

  await page.goto(`/students/${extraId}`)
  await expect(
    page.getByRole('region', { name: 'Balance' }).getByText('₹500 paid extra'),
  ).toBeVisible()
})

test('deleting a student asks first, then removes them and their payments', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const name = uniqueName('Sana')
  const id = await createStudent(request, {
    name,
    monthly_fee_paise: 150000,
    joined_month: addMonths(now, -1),
  })
  await pay(request, { student_id: id, amount_paise: 150000, for_month: addMonths(now, -1) })
  await pay(request, { student_id: id, amount_paise: 150000, for_month: now })

  await page.goto('/students')
  const activeTab = page.getByRole('tab', { name: /Active/ })
  await expect(page.getByRole('link', { name })).toBeVisible()
  const before = Number((await activeTab.textContent())?.replace(/\D/g, ''))

  await page.getByRole('link', { name }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  const confirm = page.getByRole('alertdialog')
  await expect(confirm).toContainText('This also deletes 2 payments (₹3,000)')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()

  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete student' }).click()
  await expect(page).toHaveURL(/\/students$/)
  await expect(page.getByRole('link', { name })).toHaveCount(0)
  await expect(activeTab).toContainText(String(before - 1))

  const payments = await request.get(`/api/payments?student_id=${id}`)
  expect(await payments.json()).toEqual([])
})

test('a change the server refuses shows its reason next to the field', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const name = uniqueName('Tanvi')
  const id = await createStudent(request, {
    name,
    monthly_fee_paise: 150000,
    joined_month: addMonths(now, -3),
  })
  await changeFee(request, id, 180000, addMonths(now, -1))

  await page.goto(`/students/${id}`)
  await page.getByRole('button', { name: 'Edit' }).click()
  const dialog = page.getByRole('dialog', { name: `Edit ${name}` })
  // Joining after the fee change would lose the first fee: only the server knows that.
  await pickMonth(page, 'Joined in', now)
  await dialog.getByRole('button', { name: 'Save changes' }).click()
  await expect(
    dialog.getByText(/The joined month can't be on or after a later fee change/),
  ).toBeVisible()
  await expect(dialog).toBeVisible()
})

test('a month paid twice instead of the next one still shows as owed', async ({
  page,
  request,
}) => {
  // Like "July paid twice instead of August": the net balance is 0, but a month is owed.
  const now = await serverMonth(request)
  const [twice, missed] = [addMonths(now, -2), addMonths(now, -1)]
  const name = uniqueName('Uma')
  const id = await createStudent(request, { name, monthly_fee_paise: 100000, joined_month: twice })
  await pay(request, { student_id: id, amount_paise: 100000, for_month: twice })
  await pay(request, { student_id: id, amount_paise: 100000, for_month: twice })
  await pay(request, { student_id: id, amount_paise: 100000, for_month: now })

  await page.goto(`/students/${id}`)
  const balance = page.getByRole('region', { name: 'Balance' })
  await expect(balance.getByText(/^Owes ₹1,000/)).toBeVisible()
  await expect(balance.getByText(`(${formatMonth(missed).slice(0, 3)})`)).toBeVisible()
  await expect(balance.getByText(`Paid ₹1,000 extra in ${MONTH_SHORT(twice)}`)).toBeVisible()
  await expect(balance.getByText('Up to date')).toHaveCount(0)

  await page.goto('/students')
  const row = page.getByRole('row').filter({ has: page.getByRole('link', { name }) })
  await expect(row.getByText('Owes ₹1,000')).toBeVisible()
  await expect(row.getByText('₹1,000 paid extra')).toBeVisible()
})

test('moving the joined month past a payment shows "owes", not credit', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const name = uniqueName('Vani')
  const id = await createStudent(request, {
    name,
    monthly_fee_paise: 150000,
    joined_month: addMonths(now, -1),
  })
  await pay(request, { student_id: id, amount_paise: 150000, for_month: addMonths(now, -1) })
  const moved = await request.patch(`/api/students/${id}`, { data: { joined_month: now } })
  expect(moved.ok()).toBe(true)

  await page.goto(`/students/${id}`)
  const balance = page.getByRole('region', { name: 'Balance' })
  await expect(balance.getByText(/^Owes ₹1,500/)).toBeVisible()
  await expect(balance.getByText(/^Credit/)).toHaveCount(0)
  await expect(
    balance.getByText(`Paid ₹1,500 extra in ${MONTH_SHORT(addMonths(now, -1))}`),
  ).toBeVisible()
})

test('Enter never switches the student: the one on the row is the one paid', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  // Two students, so a wrong pick would be visible.
  const first = uniqueName('Aaditya')
  await createStudent(request, { name: first, monthly_fee_paise: 90000, joined_month: now })
  const name = uniqueName('Yamini')
  const id = await createStudent(request, { name, monthly_fee_paise: 110000, joined_month: now })

  await page.goto('/')
  await panel(page, /Yet to pay/)
    .getByRole('button', { name: `Log payment for ${name}` })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Log a payment' })
  // The original bug: Enter on the student box opened the list, and Enter again picked
  // whoever came first. Now Enter on the chosen student saves for that student.
  await dialog.getByRole('combobox', { name: /^Student:/ }).focus()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Payment saved')).toBeVisible()
  await expect.poll(() => paymentCount(request, id)).toBe(1)
  const payments = (await (await request.get(`/api/payments?student_id=${id}`)).json()) as {
    amount_paise: number
  }[]
  expect(payments[0]?.amount_paise).toBe(110000)
  const firstPaid = (await (
    await request.get(`/api/payments?q=${encodeURIComponent(first)}`)
  ).json()) as unknown[]
  expect(firstPaid).toHaveLength(0)

  // Opening the list starts on the chosen student too.
  const other = uniqueName('Zoya')
  const otherId = await createStudent(request, {
    name: other,
    monthly_fee_paise: 120000,
    joined_month: now,
  })
  await page.goto('/')
  await panel(page, /Yet to pay/)
    .getByRole('button', { name: `Log payment for ${other}` })
    .click()
  await dialog.getByRole('combobox', { name: /^Student:/ }).click()
  await expect(page.getByRole('option', { name: new RegExp(other) })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.keyboard.press('Enter')
  await expect(dialog.getByRole('combobox', { name: /^Student:/ })).toContainText(other)
  await dialog.getByRole('button', { name: 'Save payment' }).click()
  await expect.poll(() => paymentCount(request, otherId)).toBe(1)
})

test('Undo removes the payment just saved', async ({ page, request }) => {
  const now = await serverMonth(request)
  const name = uniqueName('Hema')
  const id = await createStudent(request, { name, monthly_fee_paise: 130000, joined_month: now })

  await page.goto('/')
  await panel(page, /Yet to pay/)
    .getByRole('button', { name: `Log payment for ${name}` })
    .click()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Payment saved')).toBeVisible()
  await expect.poll(() => paymentCount(request, id)).toBe(1)

  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText('Payment removed')).toBeVisible()
  await expect.poll(() => paymentCount(request, id)).toBe(0)
  await expect(panel(page, /Yet to pay/).getByRole('link', { name })).toBeVisible()
})

test('pressing Enter or clicking Save twice saves only one payment', async ({ page, request }) => {
  const now = await serverMonth(request)
  const name = uniqueName('Gita')
  const id = await createStudent(request, { name, monthly_fee_paise: 140000, joined_month: now })

  await page.goto('/')
  await panel(page, /Yet to pay/)
    .getByRole('button', { name: `Log payment for ${name}` })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Log a payment' })
  await expect(dialog.getByLabel('Amount')).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await expect(page.getByText('Payment saved')).toBeVisible()

  const other = uniqueName('Gauri')
  const otherId = await createStudent(request, {
    name: other,
    monthly_fee_paise: 140000,
    joined_month: now,
  })
  await page.goto('/')
  await panel(page, /Yet to pay/)
    .getByRole('button', { name: `Log payment for ${other}` })
    .click()
  await dialog.getByRole('button', { name: 'Save payment' }).dblclick()
  await expect(page.getByText('Payment saved')).toBeVisible()

  await page.waitForTimeout(500) // any second save would have landed by now
  expect(await paymentCount(request, id)).toBe(1)
  expect(await paymentCount(request, otherId)).toBe(1)
})

test('a payment for a month after leaving is flagged, never "paid ahead"', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const [joined, last] = [addMonths(now, -2), addMonths(now, -1)]
  const name = uniqueName('Wamiqa')
  const id = await createStudent(request, {
    name,
    monthly_fee_paise: 150000,
    joined_month: joined,
    left_month: last,
  })
  await pay(request, { student_id: id, amount_paise: 150000, for_month: joined })
  // Meant for their last month, but logged for next month by mistake.
  await pay(request, { student_id: id, amount_paise: 150000, for_month: addMonths(now, 1) })

  await page.goto(`/students/${id}`)
  const balance = page.getByRole('region', { name: 'Balance' })
  await expect(balance.getByText(/^Owes ₹1,500/)).toBeVisible()
  await expect(balance.getByText(`₹1,500 paid for ${MONTH_SHORT(addMonths(now, 1))}`)).toBeVisible()
  await expect(
    balance.getByText(`after they left — was it for ${formatMonth(last).slice(0, 3)}?`, {
      exact: false,
    }),
  ).toBeVisible()
  await expect(balance.getByText(/Paid ahead/)).toHaveCount(0)
  // Two months enrolled, both counted.
  await expect(
    page.getByText(`left after ${formatMonth(last)} (2 mo)`, { exact: false }),
  ).toBeVisible()
})
