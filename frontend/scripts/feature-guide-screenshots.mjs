/**
 * Retake the pictures in docs/images/feature-guide/ (`make guide-screenshots`).
 *
 * Runs the real app (the same FastAPI app and built UI as `python -m app`, through
 * scripts/guide_server.py) three times, each on a free port with its own throwaway data folder:
 * one with the fictional demo data (`app.seed`),
 * one empty (the first-run screen), and a copy of the demo data that is changed and then stopped
 * (a fee change already scheduled, Undo, "leaving", a payment after leaving, extra kept as credit,
 * and the "Can't reach Scrappy Records" banner). The last demo pictures mark a student who left as coming again.
 * A second copy of the demo data takes an Excel upload (`guide_server.py sample-upload`), for
 * the upload preview and the unassigned payments it leaves.
 * Nothing here touches ./.devdata or a real install.
 *
 * The date is frozen at GUIDE_TODAY, on the server (scripts/guide_server.py overrides
 * `app.clock.get_today`) and in the browser (Playwright's clock), so the pictures and the numbers
 * quoted in docs/feature-guide.md stay the same whenever they're retaken. Change GUIDE_TODAY only
 * together with those numbers.
 *
 * Needs `make build` first (the make target does it) and Chromium for Playwright
 * (`npx playwright install chromium`). The pictures are 1280 px wide and are shrunk to
 * 256-colour PNGs by scripts/shrink_screenshots.py.
 */
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from '@playwright/test'

/** "Today" in every picture. The guide's text quotes numbers from this day's demo data. */
const GUIDE_TODAY = '2026-09-15'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outDir = path.join(repo, 'docs/images/feature-guide')
const work = mkdtempSync(path.join(tmpdir(), 'scrappy-guide-'))
const rawDir = path.join(work, 'raw')
mkdirSync(rawDir)

if (!existsSync(path.join(repo, 'backend/app/static/index.html'))) {
  console.error('The UI isn’t built. Run `make build` first (or use `make guide-screenshots`).')
  process.exit(1)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function makeHome(name, { seed }) {
  const home = path.join(work, name)
  mkdirSync(path.join(home, 'backups'), { recursive: true })
  const env = { ...process.env, SCRAPPY_HOME: home, SCRAPPY_BACKUP_DIR: path.join(home, 'backups') }
  if (seed) {
    execFileSync('uv', [...GUIDE_SERVER, 'seed', '--today', GUIDE_TODAY], {
      cwd: repo,
      env,
      stdio: 'inherit',
    })
  }
  return { home, env }
}

const GUIDE_SERVER = ['run', '--project', 'backend', 'python', 'scripts/guide_server.py']
const servers = []
async function serve({ env }) {
  const port = await freePort()
  // Its own process group, so stopping it stops the server behind `uv run` too.
  const proc = spawn(
    'uv',
    [...GUIDE_SERVER, 'serve', '--today', GUIDE_TODAY, '--port', String(port)],
    {
      cwd: repo,
      env,
      stdio: 'ignore',
      detached: true,
    },
  )
  const server = { url: `http://127.0.0.1:${port}`, stop: () => process.kill(-proc.pid, 'SIGTERM') }
  servers.push(server)
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${server.url}/api/health`)).ok) return server
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('The server didn’t start')
}
function stopAll() {
  for (const s of servers.splice(0)) {
    try {
      s.stop()
    } catch {
      // already stopped
    }
  }
}
process.on('exit', stopAll)
process.on('SIGINT', () => process.exit(130))

const demoHome = makeHome('demo', { seed: true })
const emptyHome = makeHome('empty', { seed: false })
const copyHome = makeHome('copy', { seed: false })
cpSync(path.join(demoHome.home, 'data'), path.join(copyHome.home, 'data'), { recursive: true })
const excelHome = makeHome('excel', { seed: false })
cpSync(path.join(demoHome.home, 'data'), path.join(excelHome.home, 'data'), { recursive: true })
const demo = await serve(demoHome)
const empty = await serve(emptyHome)
const copy = await serve(copyHome)
const excel = await serve(excelHome)

const api = async (server, route, init) => {
  const response = await fetch(`${server.url}/api${route}`, {
    ...init,
    headers: { 'content-type': 'application/json' },
  })
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`)
  return response.status === 204 ? null : response.json()
}
const now = (await api(demo, '/dashboard')).current_month
const students = await api(demo, '/students?status=all')
const idOf = (name) => {
  const s = students.find((x) => x.name === name)
  if (!s) throw new Error(`No demo student called ${name}`)
  return s.id
}
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
/** "May 2026", as the Month by month table writes it. */
const monthName = (month) => `${MONTH_NAMES[Number(month.slice(5)) - 1]} ${month.slice(0, 4)}`
const addMonths = (month, n) => {
  const [y, m] = month.split('-').map(Number)
  const i = y * 12 + m - 1 + n
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`
}

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  locale: 'en-IN',
  deviceScaleFactor: 1,
})
// The browser's "today" too (the Paid on date, "Today, 15 Sep 2026"); timers keep running.
await context.clock.setFixedTime(new Date(`${GUIDE_TODAY}T11:00:00`))
const page = await context.newPage()

const open = async (server, route) => {
  await page.goto(server.url + route)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(400)
}
/** The whole window, or the smallest box around `targets` plus `pad` pixels. */
async function shot(name, targets, pad = 12) {
  const file = path.join(rawDir, `${name}.png`)
  if (!targets) return page.screenshot({ path: file })
  const boxes = []
  for (const t of Array.isArray(targets) ? targets : [targets]) boxes.push(await t.boundingBox())
  const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad)
  const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad)
  const right = Math.min(1280, Math.max(...boxes.map((b) => b.x + b.width)) + pad)
  const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + pad
  await page.screenshot({
    path: file,
    fullPage: true,
    clip: { x, y, width: right - x, height: bottom - y },
  })
}
async function windowShot(name, height) {
  await page.setViewportSize({ width: 1280, height })
  await shot(name)
  await page.setViewportSize({ width: 1280, height: 900 })
}
const dialog = () => page.locator('[data-slot="dialog-content"]')
const popover = () => page.locator('[data-radix-popper-content-wrapper]').last()
const section = (text) => page.locator('section').filter({ hasText: text }).last()
/** Rows of the profile's Month by month table, by their month ("August 2026"). */
const monthRows = (...months) => [
  section('Month by month').getByRole('row').first(), // the headings
  ...months.map((month) =>
    section('Month by month')
      .getByRole('row')
      .filter({ has: page.getByRole('cell', { name: month, exact: true }) }),
  ),
]
const header = () => page.locator('main header').first()
const yetToPay = () => page.locator('section').filter({ has: page.locator('#yet-to-pay-heading') })
const escape = async () => {
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
}
const settle = () => page.waitForTimeout(800)
async function logPaymentFor(name) {
  await header().getByRole('button', { name: 'Log payment' }).click()
  await page.getByRole('combobox').click()
  await page.keyboard.type(name)
  await page.waitForTimeout(300)
  await page.keyboard.press('Enter')
  await settle()
}

// ---- Getting around and the Dashboard -------------------------------------------------------
await open(demo, '/')
await shot('dashboard')
await shot('sidebar', page.locator('aside'), 0)
await shot('header-log-payment', header())
await shot('dashboard-summary', page.getByRole('group', { name: 'Summary' }))
await shot('dashboard-yet-to-pay', yetToPay())
await shot('dashboard-earlier-and-extra', [
  section('Earlier months still owed'),
  section('Extra money used'),
])

await open(demo, `/?month=${addMonths(now, 1)}`)
await windowShot('dashboard-future-month', 760)
await open(demo, `/?month=${addMonths(now, -6)}`) // everyone paid in the demo data
await shot('dashboard-celebration', [header(), yetToPay()])
await open(empty, '/')
await windowShot('dashboard-first-run', 620)

// ---- Monthly report -------------------------------------------------------------------------
await open(demo, '/')
await page.getByRole('link', { name: 'Monthly report' }).click()
await settle()
await shot('report')
const reportPanel = () => page.locator('section.report-sheet')
await open(demo, `/report?month=${now}&status=owes`)
await shot('report-filtered', reportPanel())
// August: Vihaan's September payment paid it (extra money), and where from.
await open(demo, `/report?month=${addMonths(now, -1)}`)
await page.getByRole('searchbox', { name: /Search the report/ }).fill('Vihaan')
await settle()
await shot('report-credit', reportPanel())
// Print: as the printed page (A4 landscape less its margins is about 1047 px wide).
await open(demo, `/report?month=${now}`)
await page.setViewportSize({ width: 1047, height: 740 })
await page.emulateMedia({ media: 'print' })
await settle()
await page.screenshot({ path: path.join(rawDir, 'report-print.png'), fullPage: true })
await page.emulateMedia({ media: 'screen' })
await page.setViewportSize({ width: 1280, height: 900 })

// ---- Log payment ----------------------------------------------------------------------------
await open(demo, '/')
await page.getByRole('button', { name: 'Log payment for Arjun Menon' }).click()
await settle()
await shot('log-payment-from-dashboard', dialog(), 0)
await page.locator('#payment-amount').fill('2400')
await page.waitForTimeout(300)
await shot('log-payment-extra', dialog(), 0)
await escape()

await header().getByRole('button', { name: 'Log payment' }).click()
await page.getByRole('combobox').click()
await page.keyboard.type('ka')
await page.waitForTimeout(400)
await shot('log-payment-search', [dialog(), popover()], 0)
await page.getByRole('option', { name: /Kavya Pillai/ }).click()
await settle()
await shot('log-payment-oldest-unpaid', dialog(), 0)
await escape()

await logPaymentFor('Ananya')
await shot('log-payment-all-paid', dialog(), 0)
await page.locator('#payment-amount').fill('15000')
await page.waitForTimeout(300)
await shot('log-payment-large-amount', dialog(), 0)
await escape()

await logPaymentFor('Myra')
await page.getByRole('button', { name: /^For month:/ }).click()
await page.waitForTimeout(400)
await shot('log-payment-month-picker', [dialog(), popover()], 0)
await escape()
await escape()

// ---- Payments -------------------------------------------------------------------------------
await open(demo, '/payments')
await shot('payments')
await open(demo, `/payments?month=${now}&method=cash`)
await shot('payments-filtered', page.locator('main section').first())
await page
  .getByRole('button', { name: /^Delete payment:/ })
  .first()
  .click()
await page.waitForTimeout(400)
await shot('payments-delete-confirm', page.getByRole('alertdialog'), 0)
await escape()

// ---- Students -------------------------------------------------------------------------------
await open(demo, '/students')
await shot('students')
await page.getByRole('tab', { name: /Left/ }).click()
await page.waitForTimeout(300)
await shot('students-left-tab', page.locator('main section').first())
await header().getByRole('button', { name: 'New student' }).click()
await page.waitForTimeout(400)
await shot('student-new', dialog(), 0)
await escape()

// ---- Profiles -------------------------------------------------------------------------------
await open(demo, `/students/${idOf('Arjun Menon')}`) // owes several months
await shot('profile-owes')
await shot('profile-month-by-month', section('Month by month'))

await open(demo, `/students/${idOf('Aarav Bhat')}`) // paid ahead
await shot('profile-paid-ahead', [
  page.getByRole('region', { name: 'Balance' }),
  section('Month by month'),
])

await open(demo, `/students/${idOf('Vihaan Joshi')}`) // paid for two months at once
await shot('profile-credit-used', monthRows(monthName(now), monthName(addMonths(now, -1))))
// From the Payments page, where the row is on screen without scrolling (the picture is taken
// from the top of the page).
await open(demo, `/payments?student=${idOf('Vihaan Joshi')}`)
await page.getByRole('button', { name: /^Edit payment: ₹4,000/ }).click()
await settle()
await shot('edit-payment', dialog(), 0)
await escape()

await open(demo, `/students/${idOf('Ananya Rao')}`)
await page.getByRole('button', { name: 'Mark as left' }).click()
await page.waitForTimeout(400)
await shot('mark-left', dialog(), 0)
await escape()
await header().getByRole('button', { name: 'Delete' }).click()
await page.waitForTimeout(400)
await shot('student-delete-confirm', page.getByRole('alertdialog'), 0)
await escape()

await open(demo, `/students/${idOf('Rohan Desai')}`) // left
await shot('profile-left', header())

// Rohan comes back: which month, and the months away have no fee. (The copy was taken before.)
await header().getByRole('button', { name: 'Mark as coming again' }).click()
await page.waitForTimeout(400)
await shot('come-back', dialog(), 0)
await dialog().getByRole('button', { name: 'Mark as coming again' }).click()
await settle()
await shot('profile-back-month-by-month', section('Month by month'))

// ---- Excel: upload a list over a copy of the demo data --------------------------------------
const sample = path.join(work, 'new-students-september.xlsx')
execFileSync('uv', [...GUIDE_SERVER, 'sample-upload', '--today', GUIDE_TODAY, '--out', sample], {
  cwd: repo,
  env: excelHome.env,
  stdio: 'inherit',
})
await open(excel, '/students')
await shot('students-header', header())
await header().getByRole('button', { name: 'Upload Excel' }).click()
await page.waitForTimeout(400)
await shot('excel-upload-pick', dialog(), 0)
await page.getByLabel('Excel file to upload').setInputFiles(sample)
await page.getByTestId('upload-summary').waitFor()
await settle()
await shot('excel-upload-preview', dialog(), 0)
await dialog()
  .getByRole('tab', { name: /To choose/ })
  .click()
await page.waitForTimeout(300)
await shot('excel-upload-choose', dialog(), 0)
await dialog().getByRole('tab', { name: 'All rows' }).click()
await dialog().getByRole('button', { name: 'Add' }).click()
const added = page.locator('[data-sonner-toast]').first()
await added.waitFor()
await page.waitForTimeout(600)
await shot('excel-upload-added', added)
await open(excel, '/payments')
await shot('unassigned-payments', page.locator('#unassigned-payments'))
await open(excel, '/')
await shot('dashboard-unassigned-banner', [header(), page.getByText(/waiting to be assigned/)])
await open(excel, `/report?month=${now}`)
await shot('report-unassigned', page.getByTestId('report-unassigned'))
excel.stop()

// ---- On the copy: changes, then the server goes away ----------------------------------------
// Kabir's fee changed in April, and a raise to ₹2,000 is already set for November.
const kabir = idOf('Kabir Mehta')
await api(copy, `/students/${kabir}`, {
  method: 'PATCH',
  body: JSON.stringify({ monthly_fee_paise: 200000, fee_effective_month: addMonths(now, 2) }),
})
await open(copy, `/students/${kabir}`)
await shot('profile-details-fee-history', section('Details'))
await page.getByRole('button', { name: /^Remove the fee change from / }).click()
await page.waitForTimeout(400)
await shot('fee-change-remove-confirm', page.getByRole('alertdialog'), 0)
await escape()
await header().getByRole('button', { name: 'Edit' }).click()
await page.waitForTimeout(400)
await page.locator('#student-fee').fill('2100')
await page.waitForTimeout(300)
await shot('student-edit-fee-change', dialog(), 0)
await escape()

await api(copy, `/students/${idOf('Zara Khan')}`, {
  method: 'PATCH',
  body: JSON.stringify({ left_month: now }),
})
await open(copy, `/students/${idOf('Zara Khan')}`)
await shot('profile-leaving', header())

// Rohan's last payment, typed for a month after he left instead of his last month.
// Rohan's last payment logged two months after he left (it pays his last month anyway), then
// ₹500 more for that last month: no month needs it, so it's kept as credit.
const rohan = idOf('Rohan Desai')
const [lastPayment] = await api(copy, `/payments?student_id=${rohan}&sort=for_month&order=desc`)
await api(copy, `/payments/${lastPayment.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ for_month: addMonths(lastPayment.for_month, 2) }),
})
await api(copy, '/payments', {
  method: 'POST',
  body: JSON.stringify({
    student_id: rohan,
    amount_paise: 50000,
    paid_on: GUIDE_TODAY,
    for_month: lastPayment.for_month,
    method: 'cash',
  }),
})
await open(copy, `/students/${rohan}`)
await shot('profile-credit', page.getByRole('region', { name: 'Balance' }))
await shot(
  'profile-paid-after-leaving',
  monthRows(monthName(addMonths(lastPayment.for_month, 2)), monthName(lastPayment.for_month)),
)

await open(copy, '/')
await page.getByRole('button', { name: 'Log payment for Ira Banerjee' }).click()
await settle()
await page.keyboard.press('Enter')
const toast = page.locator('[data-sonner-toast]').first()
await toast.waitFor()
await page.waitForTimeout(600)
await shot('saved-toast-undo', toast)
await page.getByRole('button', { name: 'Undo' }).click()
await page.waitForTimeout(1500)

copy.stop()
await page.waitForSelector('[role="alert"]:has-text("reach Scrappy Records")', { timeout: 45_000 })
await page.waitForTimeout(300)
await windowShot('unreachable-banner', 520)

await browser.close()
stopAll()

// ---- Shrink into the docs -------------------------------------------------------------------
execFileSync(
  'uv',
  [
    'run',
    '--no-project',
    '--with',
    'pillow',
    'python',
    'scripts/shrink_screenshots.py',
    rawDir,
    outDir,
  ],
  { cwd: repo, stdio: 'inherit' },
)
rmSync(work, { recursive: true, force: true })
console.log(`Done: the demo data's current month is ${now}. Check the pictures in ${outDir}.`)
