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

const rupees = (s: string) => Number(s.replace(/[₹,]/g, ''))

describe('payments page', () => {
  it('lists every payment, newest first, with a total', async () => {
    renderApp('/payments')
    const t = await table()
    const paidOn = column('Paid on')
    expect(paidOn).toHaveLength(mockDb.payments.length)
    expect(paidOn[0]).toBe('15 Oct 2026')
    const total = mockDb.payments.reduce((sum, p) => sum + p.amount_paise, 0) / 100
    const footer = t.getAllByRole('row').at(-1)!
    expect(footer.closest('tfoot')).not.toBeNull()
    expect(footer).toHaveTextContent(`${mockDb.payments.length} payments`)
    expect(footer).toHaveTextContent(`₹${total.toLocaleString('en-IN')}`)
  })

  it('sorts by clicking the column headings', async () => {
    const user = userEvent.setup()
    renderApp('/payments')
    const t = await table()

    await user.click(t.getByRole('button', { name: 'Amount' }))
    const header = t.getByRole('columnheader', { name: /Amount/ })
    const sorted = column('Amount').map(rupees)
    const direction = header.getAttribute('aria-sort')
    expect(direction).toMatch(/ascending|descending/)
    const expected = [...sorted].sort((a, b) => (direction === 'ascending' ? a - b : b - a))
    expect(sorted).toEqual(expected)

    await user.click(t.getByRole('button', { name: 'Amount' }))
    const flipped = column('Amount').map(rupees)
    expect(flipped).toEqual([...expected].reverse())

    await user.click(t.getByRole('button', { name: 'Student' }))
    const names = column('Student')
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    expect(t.getByRole('columnheader', { name: /Student/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
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
