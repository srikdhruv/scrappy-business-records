import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { mockDb } from '@/mocks/node'
import { renderApp, withMockApi } from '@/test/render'

/** The report's table rows, by student name (the first cell). */
async function rowsShown() {
  const table = await screen.findByRole('table')
  const [, body] = within(table).getAllByRole('rowgroup')
  return within(body!)
    .getAllByRole('row')
    .map((r) => within(r).getAllByRole('cell')[0]!.textContent)
}

function rowOf(name: string) {
  return within(screen.getByRole('link', { name }).closest('tr')!)
}

function totalsRow() {
  const [, , foot] = within(screen.getByRole('table')).getAllByRole('rowgroup')
  return foot!.querySelector('tr')!
}

describe('monthly report', () => {
  withMockApi()

  it('opens from the dashboard for the month shown', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/?month=2026-09')
    await screen.findByRole('heading', { level: 1, name: 'September 2026' })
    await user.click(screen.getByRole('link', { name: 'Monthly report' }))

    expect(router.state.location.pathname).toBe('/report')
    expect(router.state.location.search).toBe('?month=2026-09')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'September 2026' }),
    ).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'Kabir Mehta' })).toBeInTheDocument()
  })

  it('lists every student: unpaid first, with what they paid and where extra went', async () => {
    renderApp('/report?month=2026-10')
    const names = await rowsShown()
    const report = mockDb.report('2026-10')
    expect(names).toEqual(report.rows.map((r) => r.student_name))
    expect(report.rows[0]!.status).toBe('unpaid')
    // Aarav paid ₹3,000 for October while September was unpaid: the extra paid September.
    const aarav = rowOf('Aarav Gupta')
    expect(aarav.getByText('Paid')).toBeInTheDocument()
    expect(aarav.getByText('₹3,000')).toBeInTheDocument()
    expect(aarav.getByText(/→\s*Sep 2026/)).toBeInTheDocument()
    // Kabir owes September too.
    const kabir = rowOf('Kabir Mehta')
    expect(kabir.getByText('Unpaid')).toBeInTheDocument()
    expect(kabir.getByText('Sep 2026')).toBeInTheDocument()
    expect(kabir.getByText('₹3,000')).toBeInTheDocument() // owed now: Sep and Oct
    // Dev left long ago but has ₹200 kept as credit: this month's report lists him, so its
    // credit total is the Students list's.
    const dev = rowOf('Dev Malhotra')
    expect(dev.getByText('Left')).toBeInTheDocument()
    expect(dev.getByText(/^after /)).toBeInTheDocument()
    expect(dev.getByText('₹200 kept as credit')).toBeInTheDocument()
    // The answers come first: Student, Status, Fee, Paid, Short, Total owed now.
    const headings = screen
      .getAllByRole('columnheader')
      .map((h) => (h.querySelector('button') ?? h).textContent) // the printed copy aside
    expect(headings.slice(0, 6)).toEqual([
      'Student',
      'Status',
      'Fee',
      'Paid for this month',
      'Short',
      'Total owed now',
    ])
    expect(headings.slice(-2)).toEqual(['Class/batch', 'Phone'])
  })

  it('shows September paid with credit, with where the credit came from', async () => {
    renderApp('/report?month=2026-09')
    await screen.findByRole('table')
    const aarav = rowOf('Aarav Gupta')
    expect(aarav.getByText('Paid (from extra)')).toBeInTheDocument()
    expect(aarav.getByText(/from the \d+ Oct 2026 payment \(for Oct 2026\)/)).toBeInTheDocument()
  })

  it('has a totals row with the same sums as the dashboard', async () => {
    renderApp('/report?month=2026-10')
    await screen.findByRole('table')
    const summary = mockDb.dashboard('2026-10').summary
    const totals = within(totalsRow())
    const count = mockDb.report('2026-10').rows.length
    expect(totals.getByText(`Total · ${count} students`)).toBeInTheDocument()
    const fmt = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`
    expect(totals.getAllByText(fmt(summary.expected_paise)).length).toBeGreaterThan(0)
    expect(totals.getAllByText(fmt(summary.still_due_paise)).length).toBeGreaterThan(0)
    expect(
      totals.getByText(
        `${summary.not_fully_paid_count} of ${summary.active_student_count} not fully paid`,
      ),
    ).toBeInTheDocument()
  })

  it('filters by status and searches by name; the totals follow', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/report?month=2026-10')
    await screen.findByRole('table')

    await user.click(screen.getByRole('combobox', { name: 'Status' }))
    await user.click(await screen.findByRole('option', { name: /^Unpaid \(\d+\)$/ }))
    expect(router.state.location.search).toContain('status=unpaid')
    const unpaid = mockDb.report('2026-10').rows.filter((r) => r.status === 'unpaid')
    await waitFor(async () => expect(await rowsShown()).toEqual(unpaid.map((r) => r.student_name)))
    expect(within(totalsRow()).getByText(`Total of the ${unpaid.length} shown`)).toBeInTheDocument()
    expect(screen.getByText(/Print and\s+Download Excel have just these/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download Excel' })).toHaveAttribute(
      'href',
      '/api/report.xlsx?month=2026-10&status=unpaid',
    )

    await user.type(screen.getByRole('searchbox', { name: /Search the report/ }), 'kabir')
    expect(await rowsShown()).toEqual(['Kabir Mehta'])

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await rowsShown()).toHaveLength(mockDb.report('2026-10').rows.length)
    expect(router.state.location.search).toBe('?month=2026-10')
  })

  it('"Owes anything" is the chase list: anyone owing any month, not just this one', async () => {
    const user = userEvent.setup()
    renderApp('/report?month=2026-10')
    await screen.findByRole('table')
    await user.click(screen.getByRole('combobox', { name: 'Status' }))
    await user.click(await screen.findByRole('option', { name: /^Owes anything \(\d+\)$/ }))
    const owing = mockDb.report('2026-10').rows.filter((r) => r.owed_now_paise > 0)
    await waitFor(async () => expect(await rowsShown()).toEqual(owing.map((r) => r.student_name)))
    // Someone short only on earlier months is on it; "Short this month" is narrower.
    expect(owing.some((r) => r.short_paise === 0)).toBe(true)
    await user.click(screen.getByRole('combobox', { name: 'Status' }))
    await user.click(await screen.findByRole('option', { name: /^Short this month \(\d+\)$/ }))
    const short = mockDb.report('2026-10').rows.filter((r) => r.short_paise > 0)
    await waitFor(async () => expect(await rowsShown()).toEqual(short.map((r) => r.student_name)))
  })

  it('says what was collected, as on the dashboard, and that payments count by their month', async () => {
    renderApp('/report?month=2026-10')
    await screen.findByRole('table')
    const summary = mockDb.dashboard('2026-10').summary
    const fmt = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`
    expect(
      screen.getByText(`Collected for October 2026: ${fmt(summary.collected_paise)}`),
    ).toBeInTheDocument()
    expect(screen.getByText(/, as on the Dashboard\./)).toBeInTheDocument()
    expect(screen.getByText(/Payments count for the month they’re/)).toBeInTheDocument()
  })

  it('on a past month, the chase list is who still owes for that month or earlier', async () => {
    const user = userEvent.setup()
    renderApp('/report?month=2026-08')
    await screen.findByRole('table')
    await user.click(screen.getByRole('combobox', { name: 'Status' }))
    await user.click(
      await screen.findByRole('option', { name: /^Still owes for Aug 2026 or earlier \(\d+\)$/ }),
    )
    const august = mockDb.report('2026-08')
    const owing = august.rows.filter((r) => r.owed_before_paise + r.short_paise > 0)
    await waitFor(async () => expect(await rowsShown()).toEqual(owing.map((r) => r.student_name)))
    // Kabir owes September and October, not August or earlier: not on it.
    expect(owing.map((r) => r.student_name)).not.toContain('Kabir Mehta')
  })

  it('sorts when a column heading is clicked', async () => {
    const user = userEvent.setup()
    renderApp('/report?month=2026-10')
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Student' }))
    const names = await rowsShown()
    expect(names).toEqual([...names].sort((a, b) => a!.localeCompare(b!)))
    expect(screen.getByRole('columnheader', { name: /Student/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
  })

  it('switches month like the dashboard', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/report?month=2026-10')
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Next month, November 2026' }))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'November 2026' }),
    ).toBeInTheDocument()
    expect(router.state.location.search).toBe('?month=2026-11')
    expect(await screen.findByText(/Looking ahead: November isn’t due yet/)).toBeInTheDocument()
    await waitFor(() => expect(rowOf('Kabir Mehta').getByText('Not due yet')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Back to October 2026' }))
    expect(router.state.location.search).toBe('?month=2026-10')
  })

  it('downloads the month as Excel and prints', async () => {
    const user = userEvent.setup()
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    renderApp('/report?month=2026-10')
    await screen.findByRole('table')
    expect(screen.getByRole('link', { name: 'Download Excel' })).toHaveAttribute(
      'href',
      '/api/report.xlsx?month=2026-10',
    )
    await user.click(screen.getByRole('button', { name: 'Print' }))
    expect(print).toHaveBeenCalledOnce()
    // The printed title and date are on the page, shown only when printing.
    expect(screen.getByText('Scrappy Records — Fees report, October 2026')).toBeInTheDocument()
    expect(screen.getByText(/Printed on 15 Oct 2026/)).toBeInTheDocument()
    print.mockRestore()
  })

  it('filters by batch and groups by batch, on screen, in print and in Excel', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/report?month=2026-10')
    await screen.findByRole('table')
    const sat = mockDb.batches.find((b) => b.name === 'Sat 10am – HSR Layout')!
    const inSat = mockDb
      .report('2026-10')
      .rows.filter((r) => r.batch_id === sat.id)
      .map((r) => r.student_name)
    expect(inSat.length).toBeGreaterThan(0)

    await user.click(screen.getByRole('combobox', { name: 'Batch' }))
    await user.click(await screen.findByRole('option', { name: `${sat.name} (${inSat.length})` }))
    expect(router.state.location.search).toBe(`?month=2026-10&batch=${sat.id}`)
    await waitFor(async () => expect(await rowsShown()).toEqual(inSat))
    expect(screen.getAllByText(/Showing \d+ of \d+ students/).length).toBeGreaterThan(0)
    expect(screen.getByText(new RegExp(`Printed on .*${sat.name}`))).toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Group by' }))
    await user.click(await screen.findByRole('option', { name: 'Grouped by batch' }))
    expect(router.state.location.search).toBe(`?month=2026-10&batch=${sat.id}&group=batch`)
    const groupHeadings = () =>
      within(screen.getByRole('table'))
        .getAllByRole('rowheader')
        .map((h) => h.textContent)
    expect(groupHeadings()).toEqual([`${sat.name} · ${inSat.length} students`])
    expect(screen.getByText(/Grouped by batch/, { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download Excel' })).toHaveAttribute(
      'href',
      `/api/report.xlsx?month=2026-10&batch=${sat.id}&group=batch`,
    )

    // Clear filters: every batch again, still grouped, "No batch" last if anyone has none.
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(router.state.location.search).toBe('?month=2026-10&group=batch')
    const everyone = mockDb.report('2026-10').rows
    await waitFor(() => expect(groupHeadings().length).toBeGreaterThan(1))
    const named = mockDb.batches.filter((x) => everyone.some((r) => r.batch_id === x.id))
    const labels = groupHeadings().map((h) => h!.replace(/ · .*$/, ''))
    expect(labels.slice(0, named.length).toSorted()).toEqual(named.map((b) => b.name).toSorted())
    if (everyone.some((r) => r.batch_id === null)) expect(labels.at(-1)).toBe('No batch')
  })

  it('opens on this month without a month in the address', async () => {
    renderApp('/report')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'October 2026' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText('Every student this month: what they paid, and what’s still owed.'),
    ).toBeInTheDocument()
  })
})
