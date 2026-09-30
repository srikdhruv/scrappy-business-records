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
  await expect(reportRow(page, twice).getByText('Paid (from extra)')).toBeVisible()
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
  expect(String(sheet[1]![0])).toMatch(/^As of \d+ \w{3} \d{4}\. Payments count for the month/)
  expect(sheet[3]!.slice(0, 6)).toEqual([
    'Student',
    'Status',
    'Fee ₹',
    'Paid for this month ₹',
    'Short ₹',
    'Total owed now ₹',
  ])
  const n = report.rows.length
  const rows = sheet.slice(4, 4 + n)
  expect(rows.map((r) => r[0])).toEqual(report.rows.map((r) => r.student_name))
  const mine = rows.find((r) => r[0] === name)!
  expect(mine.slice(1, 6)).toEqual(['Partial', 1800, 1000, 800, 800])
  expect(mine.at(-1)).toBe('98765 43210')
  const totals = sheet[4 + n]!
  expect(totals[0]).toBe(`Total (${n} students)`)
  expect(totals[2]).toBe(`=SUBTOTAL(109,C5:C${4 + n})`) // adds up what Excel's filter shows
  expect(String(sheet[5 + n]![0])).toMatch(/^Collected for /)

  // With a filter and a search on screen, the file has just those rows, and says so.
  await page.getByRole('combobox', { name: 'Status' }).click()
  await page.getByRole('option', { name: /^Owes anything \(\d+\)$/ }).click()
  await page.getByRole('searchbox', { name: /Search the report/ }).fill(name)
  await expect(page.getByRole('cell', { name: 'Total of the 1 shown' })).toBeVisible()
  const [filtered] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download Excel' }).click(),
  ])
  const filteredFile = test.info().outputPath(`filtered-${filtered.suggestedFilename()}`)
  await filtered.saveAs(filteredFile)
  const filteredSheet = readXlsx(filteredFile)
  expect(filteredSheet[0]![0]).toBe(
    `Scrappy Records — Fees report, ${formatMonth(now)} · Owes anything · matching "${name}"`,
  )
  expect(filteredSheet[4]![0]).toBe(name)
  expect(filteredSheet[5]![0]).toBe('Total (1 student)')
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

test('the answers are in view at 800 px without scrolling: status and total owed', async ({
  page,
  request,
}) => {
  const now = await serverMonth(request)
  const name = uniqueName('Veer')
  await createStudent(request, { name, monthly_fee_paise: 150000, joined_month: now })
  // A long name (over 30 letters) and a "Left" status with its "after February 2026" line.
  const longName = uniqueName('Venkatanarasimha Raghavendran')
  const left = addMonths(now, -2)
  await createStudent(request, {
    name: longName,
    monthly_fee_paise: 150000,
    joined_month: addMonths(now, -3),
    left_month: left,
  })
  expect(longName.length).toBeGreaterThan(30)
  await page.setViewportSize({ width: 800, height: 900 })
  await page.goto(`/report?month=${now}`)
  const row = reportRow(page, name)
  await expect(row.getByText('Unpaid', { exact: true })).toBeVisible()
  const leftRow = reportRow(page, longName)
  await expect(leftRow.getByText(`after ${formatMonth(left)}`)).toBeVisible()
  // The name is cut short on screen, with the whole name on hover.
  await expect(leftRow.getByRole('link', { name: longName })).toHaveAttribute('title', longName)
  const container = page.locator('.report-sheet [data-slot="table-container"]')
  const owedCell = leftRow.getByRole('cell').nth(5)
  const owedBox = (await owedCell.boundingBox())!
  const inside = (await container.boundingBox())!
  expect(owedBox.x + owedBox.width).toBeLessThanOrEqual(inside.x + inside.width + 1)
  await expect(owedCell).toContainText('₹')
  const box = (await container.boundingBox())!
  for (const heading of ['Status', 'Fee', 'Paid for this month', 'Short', 'Total owed now']) {
    const header = page.getByRole('columnheader', { name: heading, exact: true })
    const edge = (await header.boundingBox())!
    expect(edge.x + edge.width, heading).toBeLessThanOrEqual(box.x + box.width + 1)
  }
})
