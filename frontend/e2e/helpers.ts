/** Shared steps for the end-to-end tests. Data is set up through the real API where the UI isn't
 * what's being tested, so each test starts from exactly the situation it needs. */
import { expect, type APIRequestContext, type Page } from '@playwright/test'

import { addMonths, formatMonth } from '../src/lib/format'

let counter = 0

/** A fictional name that no other test uses, e.g. "Ishaan Test 3k9a". */
export function uniqueName(first: string): string {
  counter += 1
  return `${first} Test ${Date.now().toString(36).slice(-4)}${counter}`
}

/** The server's current month ("YYYY-MM"): every test works relative to it. */
export async function serverMonth(request: APIRequestContext): Promise<string> {
  const response = await request.get('/api/dashboard')
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { current_month: string }).current_month
}

export async function createStudent(
  request: APIRequestContext,
  body: { name: string; monthly_fee_paise: number; joined_month: string; left_month?: string },
): Promise<number> {
  const response = await request.post('/api/students', { data: body })
  expect(response.status(), await response.text()).toBe(201)
  return ((await response.json()) as { id: number }).id
}

export async function pay(
  request: APIRequestContext,
  body: { student_id: number; amount_paise: number; for_month: string },
): Promise<number> {
  const today = new Date()
  const paidOn = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const response = await request.post('/api/payments', {
    data: { ...body, paid_on: paidOn, method: 'upi' },
  })
  expect(response.status(), await response.text()).toBe(201)
  return ((await response.json()) as { id: number }).id
}

export async function changeFee(
  request: APIRequestContext,
  studentId: number,
  feePaise: number,
  from: string,
) {
  const response = await request.patch(`/api/students/${studentId}`, {
    data: { monthly_fee_paise: feePaise, fee_effective_month: from },
  })
  expect(response.ok(), await response.text()).toBe(true)
}

/** Open a month picker (by its label) and choose `month`, moving between years as needed. */
export async function pickMonth(page: Page, label: string, month: string) {
  await page.getByRole('button', { name: new RegExp(`^${label}:`) }).click()
  const year = Number(month.slice(0, 4))
  for (let i = 0; i < 30; i++) {
    const shown = await page.getByRole('group', { name: /^Months in / }).getAttribute('aria-label')
    const shownYear = Number(shown?.replace('Months in ', ''))
    if (shownYear === year) break
    await page
      .getByRole('button', { name: shownYear < year ? 'Next year' : 'Previous year' })
      .click()
  }
  await page.getByRole('button', { name: formatMonth(month), exact: true }).click()
}

/** A row of the profile's "Month by month" table. */
export function monthRow(page: Page, month: string) {
  return page
    .locator('section', { has: page.getByRole('heading', { name: 'Month by month' }) })
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: formatMonth(month), exact: true }) })
}

export function panel(page: Page, heading: RegExp | string) {
  return page.locator('section', { has: page.getByRole('heading', { name: heading }) })
}

export { addMonths, formatMonth }
