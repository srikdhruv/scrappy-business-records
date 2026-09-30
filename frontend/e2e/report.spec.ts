/**
 * The monthly report, end to end: opened from the dashboard, filtered and searched, downloaded
 * as Excel (read back with openpyxl, from the backend's own environment), and laid out for
 * printing. See playwright.config.ts.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test, type Page } from '@playwright/test'

import { addMonths, createStudent, formatMonth, pay, serverMonth, uniqueName } from './helpers'

const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend')

/** Every row of the first sheet of an .xlsx file, as JSON (openpyxl, as the app writes it). */
function readXlsx(file: string): unknown[][] {
  const script = [
    'import json, sys, openpyxl',
    'ws = openpyxl.load_workbook(sys.argv[1]).worksheets[0]',
    'print(json.dumps([list(r) for r in ws.iter_rows(values_only=True)], default=str))',
  ].join('\n')
  const out = execFileSync('uv', ['run', '--project', backend, 'python', '-c', script, file], {
    encoding: 'utf-8',
  })
  return JSON.parse(out) as unknown[][]
}

function reportRow(page: Page, name: string) {
  return page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) })
}

interface ReportJson {
  rows: { student_name: string; status: string }[]
  totals: Record<string, number>
}

test('open the report from the dashboard, filter it and search it', async ({ page, request }) => {
  const now = await serverMonth(request)
  const last = addMonths(now, -1)
  // The owner's case: this month paid twice while last month was unpaid.
  const twice = uniqueName('Kabir')
  const id = await createStudent(request, {
    name: twice,
    monthly_fee_paise: 150000,
    joined_month: last,
  })
  await pay(request, { student_id: id, amount_paise: 300000, for_month: now })
  const unpaid = uniqueName('Meera')
  await createStudent(request, { name: unpaid, monthly_fee_paise: 120000, joined_month: now })

  await page.goto('/')
  await page.getByRole('link', { name: 'Monthly report' }).click()
  await expect(page).toHaveURL(new RegExp(`/report\\?month=${now}$`))
  await expect(page.getByRole('heading', { level: 1, name: formatMonth(now) })).toBeVisible()

  const paid = reportRow(page, twice)
  await expect(paid.getByText('Paid', { exact: true })).toBeVisible()
  await expect(paid).toContainText('₹3,000') // logged for this month
  await expect(paid).toContainText(`→ ${formatMonth(last).slice(0, 3)}`) // its extra paid last month
  await expect(reportRow(page, unpaid).getByText('Unpaid', { exact: true })).toBeVisible()

  // Last month: paid with the extra money, and it says where from.
  await page.getByRole('button', { name: `Previous month, ${formatMonth(last)}` }).click()
  await expect(page).toHaveURL(new RegExp(`month=${last}`))
  await expect(reportRow(page, twice).getByText('Paid with credit')).toBeVisible()
  await expect(reportRow(page, twice)).toContainText(/from the .* payment \(for /)
  await page.getByRole('button', { name: `Back to ${formatMonth(now)}` }).click()

  // Filter: only the unpaid.
  await page.getByRole('combobox', { name: 'Status' }).click()
  await page.getByRole('option', { name: /^Unpaid \(\d+\)$/ }).click()
  await expect(page).toHaveURL(/status=unpaid/)
  await expect(reportRow(page, unpaid)).toBeVisible()
  await expect(reportRow(page, twice)).toHaveCount(0)
  await expect(page.getByText(/^Showing \d+ of \d+ students\./)).toBeVisible()

  // Search, on top of the filter; then clear both.
  await page.getByRole('searchbox', { name: /Search the report/ }).fill(unpaid)
  await expect(page.getByRole('cell', { name: 'Total of the 1 shown' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(reportRow(page, twice)).toBeVisible()
})

test('download the report as Excel: the same rows and totals', async ({ page, request }) => {
  const now = await serverMonth(request)
  const name = uniqueName('Diya')
  const id = await createStudent(request, {
    name,
    monthly_fee_paise: 180000,
    joined_month: now,
    phone: '98765 43210',
  })
  await pay(request, { student_id: id, amount_paise: 100000, for_month: now })

  await page.goto(`/report?month=${now}`)
  await expect(reportRow(page, name)).toBeVisible()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download Excel' }).click(),
  ])
  expect(download.suggestedFilename()).toBe(`scrappy-records-report-${now}.xlsx`)
  const file = test.info().outputPath(download.suggestedFilename())
  await download.saveAs(file)

  const sheet = readXlsx(file)
  const report = (await (await request.get(`/api/report?month=${now}`)).json()) as ReportJson
  expect(sheet[0]![0]).toBe(`Scrappy Records — Fees report, ${formatMonth(now)}`)
  expect(String(sheet[1]![0])).toMatch(/^As of \d+ \w{3} \d{4}$/)
  expect(sheet[3]!.slice(0, 4)).toEqual(['Student', 'Class/batch', 'Phone', 'Fee ₹'])
  const rows = sheet.slice(4, -1)
  expect(rows.map((r) => r[0])).toEqual(report.rows.map((r) => r.student_name))
  const mine = rows.find((r) => r[0] === name)!
  expect(mine.slice(2, 6)).toEqual(['98765 43210', 1800, 1000, 0])
  expect(mine[9]).toBe(800) // short
  expect(mine[10]).toBe('Partial')
  const totals = sheet.at(-1)!
  expect(totals[0]).toBe(`Total (${report.rows.length} students)`)
  expect(totals[3]).toBe(report.totals.fee_paise! / 100)
  expect(totals[9]).toBe(report.totals.short_paise! / 100)
})

test('the print layout: no menus or buttons, a title and the date, fits A4 landscape', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const name = uniqueName('Arjun')
  await createStudent(request, { name, monthly_fee_paise: 150000, joined_month: now })

  await page.goto(`/report?month=${now}`)
  await expect(reportRow(page, name)).toBeVisible()
  const title = page.getByText(`Scrappy Records — Fees report, ${formatMonth(now)}`)
  await expect(title).toBeHidden()

  // A4 landscape less 10 mm margins is about 1047 px wide.
  await page.setViewportSize({ width: 1047, height: 740 })
  await page.emulateMedia({ media: 'print' })
  await expect(title).toBeVisible()
  await expect(page.getByText(/^Printed on \d+ \w{3} \d{4}/)).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Print' })).toBeHidden()
  await expect(page.getByRole('link', { name: 'Download Excel' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Log payment' })).toBeHidden()
  await expect(page.getByRole('searchbox')).toBeHidden()
  await expect(page.getByRole('button', { name: /Previous month/ })).toBeHidden()

  // Nothing is cut off: the table fits the page's width, so nothing needs scrolling.
  const fits = await page.evaluate(() => {
    const table = document.querySelector('.report-sheet table')!
    return table.getBoundingClientRect().right <= window.innerWidth + 1
  })
  expect(fits).toBe(true)
  // Rows never split across two pages.
  const breakInside = await reportRow(page, name).evaluate((el) => getComputedStyle(el).breakInside)
  expect(breakInside).toBe('avoid')

  await test.info().attach('report-print.png', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })
  const pdf = await page.pdf({ format: 'A4', landscape: true, preferCSSPageSize: true })
  expect(pdf.byteLength).toBeGreaterThan(1000)
})

test('a wide table scrolls inside itself, with the names kept in view', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const name = uniqueName('Zara')
  await createStudent(request, { name, monthly_fee_paise: 150000, joined_month: now })

  for (const width of [1280, 800]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`/report?month=${now}`)
    const cell = reportRow(page, name).getByRole('cell').first()
    await expect(cell).toBeVisible()
    // The page itself never scrolls sideways.
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(pageOverflow).toBeLessThanOrEqual(0)
    const container = page.locator('.report-sheet [data-slot="table-container"]')
    const scrolls = await container.evaluate((el) => el.scrollWidth > el.clientWidth)
    expect(scrolls).toBe(true)
    const before = (await cell.boundingBox())!.x
    await container.evaluate((el) => (el.scrollLeft = el.scrollWidth))
    await expect.poll(async () => (await cell.boundingBox())!.x).toBe(before)
    await expect(cell).toBeVisible()
  }
})
