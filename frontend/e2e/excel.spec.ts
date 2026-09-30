/**
 * Excel, end to end: download the Students and Payments lists, upload them again (one student
 * already here, one new), and a payment whose student isn't found waiting as unassigned until
 * it's given to a student.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { expect, test, type Page } from '@playwright/test'

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

const folder = mkdtempSync(path.join(tmpdir(), 'scrappy-excel-'))

/** Click a download link and keep the file. */
async function download(
  page: Page,
  name: string | RegExp,
): Promise<{ file: string; name: string }> {
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name }).click(),
  ])
  const saved = path.join(folder, `${Date.now()}-${file.suggestedFilename()}`)
  await file.saveAs(saved)
  return { file: saved, name: file.suggestedFilename() }
}

async function upload(page: Page, file: string) {
  await page.getByRole('button', { name: 'Upload Excel' }).click()
  const dialog = page.getByRole('dialog', { name: 'Upload Excel' })
  await dialog.getByLabel('Excel file to upload').setInputFiles(file)
  await expect(dialog.getByTestId('upload-summary')).toBeVisible()
  return dialog
}

/** Two students tagged so one search finds just them, and a payment for the second. */
async function twoStudents(page: Page) {
  const request = page.request
  const now = await serverMonth(request)
  const tag = uniqueName('Batch').replace(/ /g, '')
  const kept = uniqueName('Aditi')
  const gone = uniqueName('Nikhil')
  const keptId = await createStudent(request, {
    name: kept,
    monthly_fee_paise: 150000,
    joined_month: now,
    phone: '90000 11111',
  })
  await request.patch(`/api/students/${keptId}`, { data: { batch_label: tag } })
  const goneId = await createStudent(request, {
    name: gone,
    monthly_fee_paise: 120000,
    joined_month: now,
  })
  await request.patch(`/api/students/${goneId}`, { data: { batch_label: tag } })
  const today = new Date()
  const paidOn = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const paid = await request.post('/api/payments', {
    data: {
      student_id: goneId,
      amount_paise: 120000,
      paid_on: paidOn,
      for_month: now,
      method: 'cash',
      note: tag,
    },
  })
  expect(paid.status()).toBe(201)
  return { now, tag, kept, keptId, gone, goneId }
}

test('download both lists, upload them again: one already here, one new, and the views update', async ({
  page,
}) => {
  const { now, tag, kept, gone, goneId } = await twoStudents(page)

  // The Students list as shown: the All tab, searched for the two of them.
  await page.goto('/students?tab=all')
  await page.getByRole('searchbox', { name: 'Search students' }).fill(tag)
  await expect(page.getByRole('link', { name: gone })).toBeVisible()
  const students = await download(page, 'Download Excel')
  expect(students.name).toMatch(/^scrappy-records-students-\d{4}-\d{2}-\d{2}\.xlsx$/)

  await page.goto('/payments')
  await page.getByRole('searchbox', { name: /Search payments/ }).fill(tag)
  // The search applies a moment after typing: wait for the list to show just theirs.
  await expect(page.getByRole('table').getByText('1 payment', { exact: true })).toBeVisible()
  const payments = await download(page, 'Download Excel')
  expect(payments.name).toMatch(/^scrappy-records-payments-\d{4}-\d{2}-\d{2}\.xlsx$/)

  // One of them is deleted (their payment goes too); the other stays.
  expect((await page.request.delete(`/api/students/${goneId}`)).status()).toBe(204)

  await page.goto('/students?tab=all')
  const dialog = await upload(page, students.file)
  await expect(dialog.getByTestId('upload-summary')).toHaveText(
    'Will add 1 student. 1 already exists and will be skipped.',
  )
  const keptRow = dialog.getByRole('row').filter({ hasText: kept })
  await expect(keptRow.getByText('Already exists')).toBeVisible()
  await expect(keptRow.getByText(/^Already here:/)).toBeVisible()
  await expect(dialog.getByRole('row').filter({ hasText: gone }).getByText('New')).toBeVisible()
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByText('Added 1 student', { exact: true })).toBeVisible()
  await expect(dialog).toBeHidden()
  await page.getByRole('searchbox', { name: 'Search students' }).fill(gone)
  await expect(page.getByRole('link', { name: gone })).toBeVisible()

  // Their payment, from the Payments download, finds them again by name.
  await page.goto('/payments')
  const again = await upload(page, payments.file)
  await expect(again.getByTestId('upload-summary')).toHaveText('Will add 1 payment.')
  await expect(again.getByText(`To ${gone}`)).toBeVisible()
  await again.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByText('Added 1 payment', { exact: true })).toBeVisible()

  await page.goto('/students?tab=all')
  await page.getByRole('searchbox', { name: 'Search students' }).fill(gone)
  await page.getByRole('link', { name: gone }).click()
  await expect(monthRow(page, now).getByText('Paid')).toBeVisible()

  // Uploading the same file again adds nothing.
  await page.goto('/payments')
  const third = await upload(page, payments.file)
  await expect(third.getByTestId('upload-summary')).toHaveText(
    'Nothing new to add. 1 already exists and will be skipped.',
  )
  await expect(third.getByRole('button', { name: 'Nothing to add' })).toBeDisabled()
})

test('a payment for someone not found waits as unassigned, then is given to a student', async ({
  page,
}) => {
  const { now, tag, kept, keptId, gone, goneId } = await twoStudents(page)
  await page.goto('/payments')
  await page.getByRole('searchbox', { name: /Search payments/ }).fill(tag)
  // The search applies a moment after typing: wait for the list to show just theirs.
  await expect(page.getByRole('table').getByText('1 payment', { exact: true })).toBeVisible()
  const payments = await download(page, 'Download Excel')
  expect((await page.request.delete(`/api/students/${goneId}`)).status()).toBe(204)

  const dialog = await upload(page, payments.file)
  await expect(dialog.getByTestId('upload-summary')).toHaveText(
    'Nothing new to add. 1 payment will be kept as unassigned, to give to a student later. ' +
      '1 needs you to choose.',
  )
  await expect(dialog.getByText('Needs a student')).toBeVisible()
  await expect(
    dialog.getByRole('combobox', { name: new RegExp(`Who paid row \\d+ \\(${gone}\\)`) }),
  ).toHaveText('Keep as unassigned')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByText('Added 1 unassigned payment', { exact: true })).toBeVisible()

  // It waits at the top of Payments, and the Dashboard says so.
  const section = page.locator('section', {
    has: page.getByRole('heading', { name: /Unassigned payments/ }),
  })
  const row = section.getByRole('listitem').filter({ hasText: gone })
  await expect(row).toBeVisible()
  await page.getByRole('link', { name: 'Dashboard' }).click()
  await expect(page.getByText(/waiting to be assigned to a student/)).toBeVisible()
  await page.getByRole('link', { name: 'Assign them' }).click()

  // Give it to the other student: it becomes their payment, and their month is paid.
  await page.goto(`/students/${keptId}`)
  await expect(monthRow(page, now).getByText('Unpaid')).toBeVisible()
  await page.goto('/payments')
  const what = `₹1,200 from “${gone}”`
  await row.getByRole('combobox', { name: `Student who paid ${what}` }).click()
  await page.getByPlaceholder('Type a name…').fill(kept)
  await page.getByRole('option', { name: new RegExp(kept) }).click()
  await row.getByRole('button', { name: `Assign ${what}` }).click()
  await expect(page.getByText('Payment assigned')).toBeVisible()
  await expect(row).toHaveCount(0)

  await page.goto(`/students/${keptId}`)
  // ₹1,200 of a ₹1,500 fee: part paid.
  await expect(monthRow(page, now).getByText('Partial')).toBeVisible()
})

test('an uploaded payment double the fee pays the month still owed, as credit', async ({
  page,
}) => {
  const request = page.request
  const now = await serverMonth(request)
  const [first, missed] = [addMonths(now, -2), addMonths(now, -1)]
  const name = uniqueName('Kiara')
  const tag = uniqueName('Double').replace(/ /g, '')
  const id = await createStudent(request, { name, monthly_fee_paise: 150000, joined_month: first })
  await pay(request, { student_id: id, amount_paise: 150000, for_month: first })
  // ₹3,000 for this month, in a file: logged, downloaded, then taken out again to upload.
  const paid = await request.post('/api/payments', {
    data: { student_id: id, amount_paise: 300000, paid_on: today(), for_month: now,
            method: 'upi', note: tag },
  }) // prettier-ignore
  expect(paid.status()).toBe(201)
  await page.goto('/payments')
  await page.getByRole('searchbox', { name: /Search payments/ }).fill(tag)
  await expect(page.getByRole('table').getByText('1 payment', { exact: true })).toBeVisible()
  const file = await download(page, 'Download Excel')
  const { id: paymentId } = (await paid.json()) as { id: number }
  expect((await request.delete(`/api/payments/${paymentId}`)).status()).toBe(204)

  // Last month is owed again; the upload brings the double payment back.
  await page.goto(`/students/${id}`)
  await expect(monthRow(page, missed).getByText('Unpaid')).toBeVisible()
  await page.goto('/payments')
  const dialog = await upload(page, file.file)
  await expect(dialog.getByTestId('upload-summary')).toHaveText('Will add 1 payment.')
  await dialog.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByText('Added 1 payment', { exact: true })).toBeVisible()

  // The extra ₹1,500 pays last month, like a payment typed in.
  const short = (month: string) => {
    const [monthName, year] = formatMonth(month).split(' ')
    return `${monthName!.slice(0, 3)} ${year}`
  }
  await page.goto(`/students/${id}`)
  await expect(monthRow(page, missed).getByText('Paid', { exact: true })).toBeVisible()
  await expect(
    monthRow(page, missed).getByText(
      `₹1,500 credit from the ${formatDate(today())} payment (for ${short(now)})`,
    ),
  ).toBeVisible()
  await page.goto('/')
  await expect(
    panel(page, /Earlier months still owed/).getByRole('link', { name: new RegExp(name) }),
  ).toHaveCount(0)
})
