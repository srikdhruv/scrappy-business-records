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
    // Dev left long ago but has credit: not on this month's report.
    expect(screen.queryByRole('link', { name: 'Dev Malhotra' })).not.toBeInTheDocument()
  })

  it('shows September paid with credit, with where the credit came from', async () => {
    renderApp('/report?month=2026-09')
    await screen.findByRole('table')
    const aarav = rowOf('Aarav Gupta')
    expect(aarav.getByText('Paid with credit')).toBeInTheDocument()
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
    expect(screen.getByText(/Download Excel has all \d+/)).toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: /Search the report/ }), 'kabir')
    expect(await rowsShown()).toEqual(['Kabir Mehta'])

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(await rowsShown()).toHaveLength(mockDb.report('2026-10').rows.length)
    expect(router.state.location.search).toBe('?month=2026-10')
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
