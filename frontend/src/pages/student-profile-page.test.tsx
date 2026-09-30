import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { mockDb } from '@/mocks/node'
import { findDialog, renderApp, withMockApi } from '@/test/render'

withMockApi()

function idOf(name: string): number {
  return mockDb.students.find((s) => s.name === name)!.id
}

function monthRow(label: string) {
  const table = within(
    screen.getByRole('heading', { name: 'Month by month' }).closest('section')!,
  )
  return within(table.getByRole('cell', { name: label }).closest('tr')!)
}

describe('student profile', () => {
  it('shows the balance, month-by-month history and payments', async () => {
    renderApp(`/students/${idOf('Rohan Kulkarni')}`)
    expect(await screen.findByRole('heading', { level: 1, name: 'Rohan Kulkarni' })).toBeVisible()
    const balance = within(screen.getByRole('region', { name: 'Balance' }))
    expect(balance.getByText('Owes ₹4,500')).toBeInTheDocument()
    expect(balance.getByText('Not fully paid for 3 months.')).toBeInTheDocument()
    expect(monthRow('July 2026').getByText('Unpaid')).toBeInTheDocument()
    expect(monthRow('September 2026').getByText('Paid')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Payments/ })).toHaveTextContent('4')
  })

  it('marks payments for future months as paid ahead', async () => {
    renderApp(`/students/${idOf('Meera Iyer')}`)
    await screen.findByRole('heading', { level: 1, name: 'Meera Iyer' })
    expect(monthRow('November 2026').getByText('Paid ahead')).toBeInTheDocument()
    expect(monthRow('October 2026').getByText('Paid')).toBeInTheDocument()
  })

  it('changes the fee from a chosen month, keeping earlier months', async () => {
    const user = userEvent.setup()
    const id = idOf('Ananya Rao')
    renderApp(`/students/${id}`)
    await screen.findByRole('heading', { level: 1, name: 'Ananya Rao' })
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = await findDialog('Edit Ananya Rao')

    expect(dialog.queryByText('New fee applies from')).not.toBeInTheDocument()
    const fee = dialog.getByLabelText('Monthly fee')
    await user.clear(fee)
    await user.type(fee, '1800')
    // Asking "from which month?", defaulting to this month.
    const from = dialog.getByLabelText('New fee applies from')
    expect(from).toHaveTextContent('October 2026')
    expect(dialog.getByText(/Earlier months keep the old fee of/)).toHaveTextContent('₹1,500')

    // Pick September instead.
    await user.click(from)
    await user.click(await screen.findByRole('button', { name: 'September 2026' }))
    expect(from).toHaveTextContent('September 2026')
    await user.click(dialog.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByText('Changes saved')).toBeInTheDocument()
    await waitFor(() => expect(monthRow('September 2026').getByText('₹1,800')).toBeInTheDocument())
    expect(monthRow('August 2026').getAllByText('₹1,500')).toHaveLength(2) // fee and paid
    // September was paid at the old fee, so now it's partly paid.
    expect(monthRow('September 2026').getByText('Partial')).toBeInTheDocument()
    expect(mockDb.fees.filter((f) => f.student_id === id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ effective_month: '2026-09', amount_paise: 180000 }),
      ]),
    )
  })

  it('marks a student as left', async () => {
    const user = userEvent.setup()
    renderApp(`/students/${idOf('Ananya Rao')}`)
    await screen.findByRole('heading', { level: 1, name: 'Ananya Rao' })
    await user.click(screen.getByRole('button', { name: 'Mark as left' }))
    const dialog = await findDialog('Mark Ananya Rao as left?')
    expect(dialog.getByLabelText('Last month they should pay for')).toHaveTextContent(
      'October 2026',
    )
    await user.click(dialog.getByRole('button', { name: 'Mark as left' }))
    expect(await screen.findByText('Left after October 2026')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark as coming again' })).toBeInTheDocument()
  })

  it('deletes a student only after confirming, saying how many payments go with them', async () => {
    const user = userEvent.setup()
    const id = idOf('Rohan Kulkarni')
    const { router } = renderApp(`/students/${id}`)
    await screen.findByRole('heading', { level: 1, name: 'Rohan Kulkarni' })
    await user.click(screen.getByRole('button', { name: 'Delete' }))

    const confirm = within(await screen.findByRole('alertdialog'))
    expect(confirm.getByText(/This also deletes/)).toHaveTextContent(
      'This also deletes 4 payments (₹6,000)',
    )
    await user.click(confirm.getByRole('button', { name: 'Cancel' }))
    expect(mockDb.students.some((s) => s.id === id)).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete student' }),
    )
    await waitFor(() => expect(router.state.location.pathname).toBe('/students'))
    expect(mockDb.students.some((s) => s.id === id)).toBe(false)
    expect(mockDb.payments.some((p) => p.student_id === id)).toBe(false)
  })

  it('says so when the student does not exist', async () => {
    renderApp('/students/9999')
    expect(await screen.findByText('This student doesn’t exist any more.')).toBeInTheDocument()
  })
})
