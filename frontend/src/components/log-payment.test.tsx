import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { mockDb } from '@/mocks/node'
import { findDialog, renderApp, withMockApi } from '@/test/render'

withMockApi()

async function openFromHeader() {
  const user = userEvent.setup()
  renderApp('/payments')
  await screen.findByRole('table')
  await user.click(screen.getByRole('button', { name: 'Log payment' }))
  const dialog = await findDialog('Log a payment')
  return { user, dialog }
}

describe('Log payment form', () => {
  it('finds a student by typing, then suggests the oldest unpaid month', async () => {
    const { user, dialog } = await openFromHeader()
    const student = dialog.getByRole('combobox', { name: /Student/ })
    student.focus()
    await user.keyboard('ro') // typing on the closed box opens the search
    await user.click(await screen.findByRole('option', { name: /Rohan Kulkarni/ }))

    expect(student).toHaveTextContent('Rohan Kulkarni')
    expect(await dialog.findByText('Oldest unpaid: July 2026')).toBeInTheDocument()
    expect(dialog.getByLabelText('Amount')).toHaveValue('1500')
    expect(dialog.getByLabelText('For month')).toHaveTextContent('July 2026')
    expect(dialog.getByText(/₹1,500 due, nothing paid yet/)).toBeInTheDocument()
    expect(dialog.getByLabelText('Paid on')).toHaveValue('2026-10-15')
    expect(dialog.getByRole('radio', { name: 'UPI' })).toHaveAttribute('aria-checked', 'true')
  })

  it('explains what is missing, inline, before saving', async () => {
    const { user, dialog } = await openFromHeader()
    await user.click(dialog.getByRole('button', { name: 'Save payment' }))
    expect(dialog.getByText('Choose who paid.')).toBeInTheDocument()
    expect(dialog.getByText('Enter the amount.')).toBeInTheDocument()
    expect(dialog.getByText('Pick the month this payment is for.')).toBeInTheDocument()

    await user.type(dialog.getByLabelText('Amount'), '0')
    expect(dialog.getByText('The amount must be more than ₹0.')).toBeInTheDocument()
    await user.clear(dialog.getByLabelText('Amount'))
    await user.type(dialog.getByLabelText('Amount'), '15,00')
    expect(dialog.getByText('Enter an amount like 1500 or 1,500.')).toBeInTheDocument()
  })

  it('saves with the chosen method and note, and can be undone', async () => {
    const { user, dialog } = await openFromHeader()
    dialog.getByRole('combobox', { name: /Student/ }).focus()
    await user.keyboard('kiara')
    await user.click(await screen.findByRole('option', { name: /Kiara Fernandes/ }))
    await dialog.findByText('Due now: October 2026')
    await user.click(dialog.getByRole('radio', { name: 'Cash' }))
    await user.type(dialog.getByLabelText(/Note/), 'Paid at class{Enter}')

    expect(await screen.findByText('Payment saved')).toBeInTheDocument()
    const saved = mockDb.payments.at(-1)!
    expect(saved).toMatchObject({ method: 'cash', note: 'Paid at class', for_month: '2026-10' })

    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(mockDb.payments.some((p) => p.id === saved.id)).toBe(false))
  })

  it('leaves the month empty when nothing is owed', async () => {
    const { user, dialog } = await openFromHeader()
    dialog.getByRole('combobox', { name: /Student/ }).focus()
    await user.keyboard('dev')
    await user.click(await screen.findByRole('option', { name: /Dev Malhotra/ }))
    expect(await dialog.findByText('All paid up. Nothing is owed right now.')).toBeInTheDocument()
    expect(dialog.getByLabelText('For month')).toHaveTextContent('Pick a month')
    expect(dialog.getByLabelText('Amount')).toHaveValue('')
  })

  it('shows a plain message when the server says no', async () => {
    const { user, dialog } = await openFromHeader()
    dialog.getByRole('combobox', { name: /Student/ }).focus()
    await user.keyboard('ananya')
    await user.click(await screen.findByRole('option', { name: /Ananya Rao/ }))
    await dialog.findByText(/Next due/)
    // Remove the student behind the form's back: the server answers 404.
    mockDb.deleteStudent(mockDb.students.find((s) => s.name === 'Ananya Rao')!.id)
    await user.click(dialog.getByRole('button', { name: 'Save payment' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent(/no longer exists/)
  })
})
