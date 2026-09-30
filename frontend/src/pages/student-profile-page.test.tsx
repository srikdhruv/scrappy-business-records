import { fireEvent, screen, waitFor, within } from '@testing-library/react'
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
    expect(balance.getByText(/^Owes ₹4,500/)).toBeInTheDocument()
    expect(balance.getByText('(Jul, Aug, Oct)')).toBeInTheDocument()
    expect(balance.getByText('3 months not fully paid.')).toBeInTheDocument()
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

  it('treats a payment for a month after leaving as extra, not "paid ahead"', async () => {
    // June to August, then left; paid June and July, and then ₹1,500 "for November".
    const student = mockDb.createStudent({
      name: 'Pari Test',
      monthly_fee_paise: 150000,
      joined_month: '2026-06',
      left_month: '2026-08',
    })
    for (const month of ['2026-06', '2026-07', '2026-11']) {
      mockDb.createPayment({
        student_id: student.id,
        amount_paise: 150000,
        paid_on: '2026-10-01',
        for_month: month,
        method: 'upi',
      })
    }
    renderApp(`/students/${student.id}`)
    const balance = within(await screen.findByRole('region', { name: 'Balance' }))
    expect(balance.getByText(/^Owes ₹1,500/)).toBeInTheDocument()
    expect(balance.getByText('(Aug)')).toBeInTheDocument()
    expect(balance.getByText('₹1,500 paid for Nov 2026')).toBeInTheDocument()
    expect(balance.getByText(/after they left — was it for Aug\?/)).toBeInTheDocument()
    expect(balance.queryByText(/Paid ahead/)).not.toBeInTheDocument()
    // Three months enrolled, June to August.
    expect(screen.getByText(/left after August 2026 \(3 mo\)/)).toBeInTheDocument()
  })

  it('says "No payments yet" rather than "₹0 across 0 payments"', async () => {
    const student = mockDb.createStudent({
      name: 'Rudra Test',
      monthly_fee_paise: 0,
      joined_month: '2026-10',
    })
    renderApp(`/students/${student.id}`)
    const balance = within(await screen.findByRole('region', { name: 'Balance' }))
    expect(balance.getByText('No payments yet.')).toBeInTheDocument()
    expect(balance.queryByText(/across 0 payments/)).not.toBeInTheDocument()
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
    expect(dialog.getByText(/they’ll owe/)).toHaveTextContent(
      'From October 2026 they’ll owe ₹1,800 a month. Months before October 2026 don’t change.',
    )

    // Pick September instead.
    await user.click(from)
    await user.click(await screen.findByRole('button', { name: 'September 2026' }))
    expect(from).toHaveTextContent('September 2026')
    expect(dialog.getByText(/they’ll owe/)).toHaveTextContent(
      'From September 2026 they’ll owe ₹1,800 a month. Months before September 2026 don’t change, but the months since then do.',
    )
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

  describe('with a fee change already scheduled', () => {
    // Ananya: ₹1,500 now, and ₹1,800 set to start in December 2026 (this month is October).
    function schedule() {
      const id = idOf('Ananya Rao')
      mockDb.updateStudent(id, { monthly_fee_paise: 180000, fee_effective_month: '2026-12' })
      return id
    }

    async function editFee(user: ReturnType<typeof userEvent.setup>, value: string) {
      await user.click(screen.getByRole('button', { name: 'Edit' }))
      const dialog = await findDialog('Edit Ananya Rao')
      const fee = dialog.getByLabelText('Monthly fee')
      await user.clear(fee)
      await user.type(fee, value)
      return dialog
    }

    it('says the new fee lasts only until the scheduled one starts', async () => {
      const user = userEvent.setup()
      renderApp(`/students/${schedule()}`)
      await screen.findByRole('heading', { level: 1, name: 'Ananya Rao' })
      const dialog = await editFee(user, '2100')
      expect(dialog.getByText(/they’ll owe/)).toHaveTextContent(
        'From October 2026 they’ll owe ₹2,100 a month, until December 2026, when ₹1,800 (already scheduled) starts.',
      )
      expect(dialog.queryByText(/Earlier months keep the old fee/)).not.toBeInTheDocument()
    })

    it('can set the fee back to today’s from the scheduled month', async () => {
      const user = userEvent.setup()
      const id = schedule()
      renderApp(`/students/${id}`)
      await screen.findByRole('heading', { level: 1, name: 'Ananya Rao' })
      // Today's fee typed again: "applies from" still shows, so a later month can be chosen.
      const dialog = await editFee(user, '1500')
      const from = dialog.getByLabelText(/^New fee applies from:/)
      expect(
        dialog.getByText('That’s already their fee in October 2026, so nothing changes.'),
      ).toBeInTheDocument()
      await user.click(from)
      await user.click(await screen.findByRole('button', { name: 'December 2026' }))
      expect(dialog.getByText(/they’ll owe/)).toHaveTextContent(
        'From December 2026 they’ll owe ₹1,500 a month. It replaces the ₹1,800 already set for December 2026.',
      )
      await user.click(dialog.getByRole('button', { name: 'Save changes' }))
      expect(await screen.findByText('Changes saved')).toBeInTheDocument()
      expect(
        mockDb.fees.find((f) => f.student_id === id && f.effective_month === '2026-12'),
      ).toMatchObject({ amount_paise: 150000 })
    })

    it('lists the fee history and removes a scheduled change after confirming', async () => {
      const user = userEvent.setup()
      const id = schedule()
      renderApp(`/students/${id}`)
      await screen.findByRole('heading', { level: 1, name: 'Ananya Rao' })
      const history = within(screen.getByRole('list', { name: 'Fee history' }))
      const items = history.getAllByRole('listitem')
      expect(items.map((li) => li.textContent)).toEqual([
        expect.stringMatching(/^₹1,500 from \w{3} 2025$/),
        '₹1,800 from Dec 2026(not started yet)Remove',
      ])
      // The first (joining) fee can't be removed.
      expect(within(items[0]!).queryByRole('button')).not.toBeInTheDocument()

      await user.click(
        history.getByRole('button', { name: 'Remove the fee change from December 2026' }),
      )
      const confirm = within(await screen.findByRole('alertdialog'))
      expect(confirm.getByText(/After this/)).toHaveTextContent(
        'After this, from December 2026 they’ll owe ₹1,500 a month. Nothing else changes.',
      )
      await user.click(confirm.getByRole('button', { name: 'Remove fee change' }))
      expect(await screen.findByText('Fee change removed')).toBeInTheDocument()
      expect(mockDb.fees.filter((f) => f.student_id === id)).toHaveLength(1)
      await waitFor(() =>
        expect(screen.queryByRole('list', { name: 'Fee history' })).not.toBeInTheDocument(),
      )
    })
  })

  describe('Mark as coming again', () => {
    // Advait left after July 2026 and paid everything up to then; this month is October.
    it('asks which month they’re back from, and the months away are never owed', async () => {
      const user = userEvent.setup()
      const id = idOf('Advait Sinha')
      renderApp(`/students/${id}`)
      await screen.findByRole('heading', { level: 1, name: 'Advait Sinha' })
      await user.click(screen.getByRole('button', { name: 'Mark as coming again' }))
      const dialog = await findDialog('Mark Advait Sinha as coming again?')
      const month = dialog.getByLabelText(/^Which month are they back from\?:/)
      expect(month).toHaveTextContent('October 2026') // this month, by default
      expect(dialog.getByText(/nothing is owed for the months away/)).toHaveTextContent(
        'August–September 2026: no fee, so nothing is owed for the months away.',
      )
      expect(dialog.getByText(/they’ll owe/)).toHaveTextContent(
        'From October 2026 they’ll owe ₹1,500 a month.',
      )
      expect(dialog.getByLabelText('Monthly fee from then')).toHaveValue('1500')
      // Months before the one after they left can't be picked.
      await user.click(month)
      expect(await screen.findByRole('button', { name: 'July 2026' })).toBeDisabled()
      await user.keyboard('{Escape}')

      await user.click(dialog.getByRole('button', { name: 'Mark as coming again' }))
      expect(await screen.findByText('Advait Sinha is coming again')).toBeInTheDocument()
      await waitFor(() => expect(monthRow('August 2026').getByText('No fee')).toBeInTheDocument())
      expect(monthRow('September 2026').getByText('No fee')).toBeInTheDocument()
      expect(monthRow('October 2026').getByText('Unpaid')).toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Balance' })).toHaveTextContent(
        'Owes ₹1,500(Oct)1 month not fully paid.',
      )
      expect(mockDb.students.find((s) => s.id === id)!.left_month).toBeNull()
    })

    it('lets someone who left come back straight after, as if they never left', async () => {
      const user = userEvent.setup()
      const id = idOf('Advait Sinha')
      renderApp(`/students/${id}`)
      await screen.findByRole('heading', { level: 1, name: 'Advait Sinha' })
      await user.click(screen.getByRole('button', { name: 'Mark as coming again' }))
      const dialog = await findDialog('Mark Advait Sinha as coming again?')
      await user.click(dialog.getByLabelText(/^Which month are they back from\?:/))
      await user.click(await screen.findByRole('button', { name: 'August 2026' }))
      expect(dialog.getByText(/as if they never left/)).toHaveTextContent(
        'Every month from August 2026 counts, as if they never left.',
      )
      expect(dialog.queryByText(/no fee/)).not.toBeInTheDocument()
    })

    it('can come back on a different fee, and saves once however fast it’s clicked', async () => {
      const user = userEvent.setup()
      const id = idOf('Advait Sinha')
      renderApp(`/students/${id}`)
      await screen.findByRole('heading', { level: 1, name: 'Advait Sinha' })
      await user.click(screen.getByRole('button', { name: 'Mark as coming again' }))
      const dialog = await findDialog('Mark Advait Sinha as coming again?')
      const fee = dialog.getByLabelText('Monthly fee from then')
      await user.clear(fee)
      await user.type(fee, '1800')
      expect(dialog.getByText(/they’ll owe/)).toHaveTextContent(
        'From October 2026 they’ll owe ₹1,800 a month.',
      )
      const before = mockDb.fees.length
      const calls = vi.spyOn(mockDb, 'returnStudent')
      // Two submits in the same moment (a double press of Enter): only one save.
      const form = dialog.getByRole('button', { name: 'Mark as coming again' }).closest('form')!
      fireEvent.submit(form)
      fireEvent.submit(form)
      expect(await screen.findByText('Advait Sinha is coming again')).toBeInTheDocument()
      const added = mockDb.fees.filter((f) => f.student_id === id).slice(-2)
      expect(added).toEqual([
        expect.objectContaining({ effective_month: '2026-08', amount_paise: 0 }),
        expect.objectContaining({ effective_month: '2026-10', amount_paise: 180000 }),
      ])
      expect(mockDb.fees.length).toBe(before + 2)
      expect(calls).toHaveBeenCalledTimes(1)
    })

    it('says when they have no fee now, and from when they will', async () => {
      const id = idOf('Advait Sinha')
      mockDb.returnStudent(id, { from_month: '2026-12' })
      renderApp(`/students/${id}`)
      await screen.findByRole('heading', { level: 1, name: 'Advait Sinha' })
      expect(screen.getByText(/until December 2026/).closest('dd')).toHaveTextContent(
        'No fee until December 2026, then ₹1,500',
      )
    })

    it('doesn’t offer "Still coming" in Edit once they have left', async () => {
      const user = userEvent.setup()
      renderApp(`/students/${idOf('Advait Sinha')}`)
      await screen.findByRole('heading', { level: 1, name: 'Advait Sinha' })
      await user.click(screen.getByRole('button', { name: 'Edit' }))
      const dialog = await findDialog('Edit Advait Sinha')
      expect(dialog.getByText(/use Mark as coming again on their profile/)).toBeInTheDocument()
      await user.click(dialog.getByLabelText(/^Left in month:/))
      await screen.findByRole('button', { name: 'July 2026' })
      expect(screen.queryByRole('button', { name: 'Still coming' })).not.toBeInTheDocument()
    })
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
