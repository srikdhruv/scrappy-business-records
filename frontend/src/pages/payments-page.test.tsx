import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { mockDb } from '@/mocks/node'
import { findDialog, renderApp, withMockApi } from '@/test/render'

withMockApi()

async function table() {
  return within(await screen.findByRole('table'))
}

/** The text of one column (by its heading) for every payment row. Plain DOM queries: fast. */
function column(header: string): string[] {
  const table = screen.getByRole('table')
  const headers = [...table.querySelectorAll('thead th')].map((h) => h.textContent?.trim())
  const index = headers.indexOf(header)
  return [...table.querySelectorAll('tbody tr')].map(
    (row) => row.querySelectorAll('td')[index]?.textContent?.trim() ?? '',
  )
}

/** Queries scoped to the table's heading row (cheap, unlike role queries over every row). */
function header() {
  return within(screen.getByRole('table').querySelector('thead')!)
}

const rupees = (s: string) => Number(s.replace(/[₹,]/g, ''))

describe('payments page', () => {
  it('lists every payment, newest first, with a total', async () => {
    renderApp('/payments')
    await table()
    const paidOn = column('Paid on')
    expect(paidOn).toHaveLength(mockDb.payments.length)
    expect(paidOn[0]).toBe('15 Oct 2026')
    const total = mockDb.payments.reduce((sum, p) => sum + p.amount_paise, 0) / 100
    const footer = screen.getByRole('table').querySelector('tfoot tr')!
    expect(footer).toHaveTextContent(`${mockDb.payments.length} payments`)
    expect(footer).toHaveTextContent(`₹${total.toLocaleString('en-IN')}`)
  })

  it('sorts by clicking the column headings', async () => {
    const user = userEvent.setup()
    renderApp('/payments')
    await table()

    await user.click(header().getByRole('button', { name: 'Amount' }))
    const amountHeading = header().getByRole('columnheader', { name: /Amount/ })
    const sorted = column('Amount').map(rupees)
    const direction = amountHeading.getAttribute('aria-sort')
    expect(direction).toMatch(/ascending|descending/)
    const expected = [...sorted].sort((a, b) => (direction === 'ascending' ? a - b : b - a))
    expect(sorted).toEqual(expected)

    await user.click(header().getByRole('button', { name: 'Amount' }))
    const flipped = column('Amount').map(rupees)
    expect(flipped).toEqual([...expected].reverse())

    await user.click(header().getByRole('button', { name: 'Student' }))
    const names = column('Student')
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    expect(header().getByRole('columnheader', { name: /Student/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
  })

  it('shows oldest first on the first click on Paid on, which starts newest first', async () => {
    const user = userEvent.setup()
    renderApp('/payments')
    await table()
    const heading = () => header().getByRole('columnheader', { name: /Paid on/ })
    expect(heading()).toHaveAttribute('aria-sort', 'descending')
    const newestFirst = column('Paid on')

    await user.click(header().getByRole('button', { name: 'Paid on' }))
    expect(heading()).toHaveAttribute('aria-sort', 'ascending')
    const oldestFirst = column('Paid on')
    expect(oldestFirst[0]).not.toBe(newestFirst[0])
    expect(oldestFirst.at(-1)).toBe(newestFirst[0])

    await user.click(header().getByRole('button', { name: 'Paid on' }))
    expect(column('Paid on')[0]).toBe(newestFirst[0])
  })

  it('searches by student name', async () => {
    const user = userEvent.setup()
    renderApp('/payments')
    await table()
    await user.type(screen.getByRole('searchbox'), 'aarav')
    await waitFor(() => expect(new Set(column('Student'))).toEqual(new Set(['Aarav Gupta'])))
  })

  it('deletes a payment after confirming what will be deleted', async () => {
    const user = userEvent.setup()
    renderApp('/payments?q=Zara')
    const t = await table()
    await waitFor(() => expect(column('Student').every((n) => n === 'Zara Khan')).toBe(true))
    const before = mockDb.payments.length

    await user.click(
      t.getAllByRole('button', { name: /^Delete payment: ₹1,500 from Zara Khan/ })[0]!,
    )
    const confirm = within(await screen.findByRole('alertdialog'))
    expect(confirm.getByText(/will be deleted/)).toHaveTextContent(
      /₹1,500 from Zara Khan for (September|October) 2026, paid on .* by (UPI|Cash), will be deleted/,
    )
    await user.click(confirm.getByRole('button', { name: 'Delete payment' }))

    expect(await screen.findByText('Payment deleted')).toBeInTheDocument()
    expect(mockDb.payments).toHaveLength(before - 1)
    await waitFor(() => expect(column('Student')).toHaveLength(1))
  })

  it('says where money above a month’s fee went', async () => {
    renderApp('/payments?q=aarav')
    const rows = await table()
    // Aarav's ₹3,000 for October: ₹1,500 pays October, ₹1,500 pays September.
    const row = within(rows.getByText('₹3,000').closest('tr')!)
    expect(row.getByText('₹1,500 went to Sep 2026')).toBeInTheDocument()
  })

  it('says, for one month, how much of the total paid other months', async () => {
    renderApp('/payments?month=2026-10')
    await table()
    expect(
      await screen.findByText('(as logged; ₹1,500 of it paid other months)'),
    ).toBeInTheDocument()
  })

  it('edits a payment in the same form', async () => {
    const user = userEvent.setup()
    renderApp('/payments?q=Zara')
    const t = await table()
    await waitFor(() => expect(column('Student')).toHaveLength(2))
    await user.click(t.getAllByRole('button', { name: /^Edit payment/ })[0]!)
    const dialog = await findDialog('Edit payment')
    const amount = dialog.getByLabelText('Amount')
    expect(amount).toHaveValue('1500')
    await user.clear(amount)
    await user.type(amount, '1200')
    await user.click(dialog.getByRole('radio', { name: 'Cash' }))
    await user.click(dialog.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Payment updated')).toBeInTheDocument()
    await waitFor(() => expect(column('Amount')).toContain('₹1,200'))
  })
})
