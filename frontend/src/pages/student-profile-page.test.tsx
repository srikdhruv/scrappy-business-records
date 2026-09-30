import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { mockDb } from '@/mocks/node'
import { findDialog, renderApp, withMockApi } from '@/test/render'

withMockApi()

function idOf(name: string): number {
  return mockDb.students.find((s) => s.name === name)!.id
}

function monthRow(label: string) {
  const table = within(screen.getByRole('heading', { name: 'Month by month' }).closest('section')!)
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

  it('points out a month that was paid too much, and opens its payment to fix it', async () => {
    const user = userEvent.setup()
    renderApp(`/students/${idOf('Arjun Nair')}`)
    await screen.findByRole('heading', { level: 1, name: 'Arjun Nair' })
    const balance = within(screen.getByRole('region', { name: 'Balance' }))
    expect(balance.getByText('₹300 paid extra')).toBeInTheDocument()
    expect(monthRow('August 2026').getByText('Paid extra')).toBeInTheDocument()

    await user.click(balance.getByRole('button', { name: 'Edit payment' }))
    const dialog = await findDialog('Edit payment')
    expect(dialog.getByLabelText('Amount')).toHaveValue('1500')
    expect(dialog.getByLabelText(/^For month:/)).toHaveTextContent('August 2026')
  })

  it('calls paying early "paid ahead", not credit', async () => {
    renderApp(`/students/${idOf('Meera Iyer')}`)
    const balance = within(await screen.findByRole('region', { name: 'Balance' }))
    expect(balance.getByText('Up to date')).toBeInTheDocument()
    expect(balance.getByText('Paid ahead to Nov 2026')).toBeInTheDocument()
    expect(
      balance.getByText('Everything due is paid, and ahead to November 2026.'),
    ).toBeInTheDocument()
  })

  it('shows the server’s reason inline when an edit is refused', async () => {
    const user = userEvent.setup()
    renderApp(`/students/${idOf('Diya Sharma')}`)
    await screen.findByRole('heading', { level: 1, name: 'Diya Sharma' })
    await user.click(screen.getByRole('button', { name: 'Edit' }))
    const dialog = await findDialog('Edit Diya Sharma')
    // Her fee changed in May 2026; joining after that would lose her first fee.
    await user.click(dialog.getByLabelText(/^Joined in:/))
    await user.click(await screen.findByRole('button', { name: 'Next year' }))
    await user.click(await screen.findByRole('button', { name: 'August 2026' }))
    await user.click(dialog.getByRole('button', { name: 'Save changes' }))
    expect(
      await dialog.findByText(/The joined month can't be on or after a later fee change/),
    ).toBeInTheDocument()
  })

  it('shows what else was paid for the month when editing a payment', async () => {
    const user = userEvent.setup()
    renderApp(`/students/${idOf('Ananya Rao')}`)
    await screen.findByRole('heading', { level: 1, name: 'Ananya Rao' })
    const payments = within(screen.getByRole('heading', { name: /Payments/ }).closest('section')!)
    await user.click((await payments.findAllByRole('button', { name: /^Edit payment/ }))[0]!)
    const dialog = await findDialog('Edit payment')
    expect(dialog.getByText(/₹1,500 fee, nothing else paid/)).toBeInTheDocument()
  })

  it('says "owes" when a month was paid twice instead of the next one', async () => {
    // Joined August at ₹1,500; paid August twice and never September or October.
    const student = mockDb.createStudent({
      name: 'Nila Test',
      monthly_fee_paise: 150000,
      joined_month: '2026-08',
    })
    for (let i = 0; i < 2; i++) {
      mockDb.createPayment({
        student_id: student.id,
        amount_paise: 150000,
        paid_on: '2026-08-05',
        for_month: '2026-08',
        method: 'upi',
      })
    }
    renderApp(`/students/${student.id}`)
    const balance = within(await screen.findByRole('region', { name: 'Balance' }))
    // The net is -₹1,500, but September and October are still owed in full.
    expect(balance.getByText(/^Owes ₹3,000/)).toBeInTheDocument()
    expect(balance.getByText('(Sep, Oct)')).toBeInTheDocument()
    expect(balance.getByText('Paid ₹1,500 extra in Aug 2026')).toBeInTheDocument()
  })

  it('says "owes" when the joined month moved past a payment', async () => {
    const student = mockDb.createStudent({
      name: 'Ojas Test',
      monthly_fee_paise: 150000,
      joined_month: '2026-09',
    })
    mockDb.createPayment({
      student_id: student.id,
      amount_paise: 150000,
      paid_on: '2026-09-05',
      for_month: '2026-09',
      method: 'upi',
    })
    mockDb.updateStudent(student.id, { joined_month: '2026-10' })
    renderApp(`/students/${student.id}`)
    const balance = within(await screen.findByRole('region', { name: 'Balance' }))
    expect(balance.getByText(/^Owes ₹1,500/)).toBeInTheDocument()
    expect(balance.queryByText(/^Credit/)).not.toBeInTheDocument()
    expect(balance.getByText('Paid ₹1,500 extra in Sep 2026')).toBeInTheDocument()
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
    const from = dialog.getByLabelText(/^New fee applies from:/)
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
    expect(dialog.getByLabelText(/^Last month they should pay for:/)).toHaveTextContent(
      'October 2026',
    )
    await user.click(dialog.getByRole('button', { name: 'Mark as left' }))
    expect(await screen.findByText('Leaving after October 2026')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Mark as staying' })).toBeInTheDocument()
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
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete student',
      }),
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
