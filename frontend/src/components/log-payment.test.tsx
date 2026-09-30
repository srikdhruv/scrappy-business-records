import { screen, waitFor, within } from '@testing-library/react'
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
    expect(dialog.getByLabelText(/^For month:/)).toHaveTextContent('July 2026')
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
    expect(dialog.getByLabelText(/^For month:/)).toHaveTextContent('Pick a month')
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

  describe('opened for a student (from the dashboard)', () => {
    async function openForKabir() {
      const user = userEvent.setup()
      renderApp('/')
      const list = within(
        (await screen.findByRole('heading', { name: /Yet to pay/ })).closest('section')!,
      )
      await user.click(list.getByRole('button', { name: 'Log payment for Kabir Mehta' }))
      const dialog = await findDialog('Log a payment')
      return { user, dialog }
    }

    it('starts on the amount, so Enter saves for that student', async () => {
      const { user, dialog } = await openForKabir()
      expect(dialog.getByLabelText('Amount')).toHaveFocus()
      await user.keyboard('{Enter}')
      expect(await screen.findByText('Payment saved')).toBeInTheDocument()
      const kabir = mockDb.students.find((s) => s.name === 'Kabir Mehta')!
      expect(mockDb.payments.at(-1)).toMatchObject({ student_id: kabir.id, for_month: '2026-10' })
    })

    it('never switches the student when Enter is pressed on the student box', async () => {
      const { user, dialog } = await openForKabir()
      const student = dialog.getByRole('combobox', { name: /Student/ })
      student.focus()
      await user.keyboard('{Enter}') // submits the form; doesn't open the list
      expect(await screen.findByText('Payment saved')).toBeInTheDocument()
      const kabir = mockDb.students.find((s) => s.name === 'Kabir Mehta')!
      expect(mockDb.payments.at(-1)!.student_id).toBe(kabir.id)
    })

    it('opens the list on the chosen student', async () => {
      const { user, dialog } = await openForKabir()
      await user.click(dialog.getByRole('combobox', { name: /Student/ }))
      const option = await screen.findByRole('option', { name: /Kabir Mehta/ })
      expect(option).toHaveAttribute('aria-selected', 'true')
      await user.keyboard('{Enter}')
      expect(dialog.getByRole('combobox', { name: /Student/ })).toHaveTextContent('Kabir Mehta')
      expect(dialog.getByLabelText('Amount')).toHaveValue('1500')
    })

    it('reads out the label and the chosen student and month', async () => {
      const { dialog } = await openForKabir()
      expect(dialog.getByRole('combobox', { name: 'Student: Kabir Mehta' })).toBeInTheDocument()
      expect(dialog.getByRole('button', { name: 'For month: October 2026' })).toBeInTheDocument()
    })
  })

  it('says what the most is, for an amount over the limit', async () => {
    const { user, dialog } = await openFromHeader()
    await user.type(dialog.getByLabelText('Amount'), '20,00,000')
    await user.click(dialog.getByRole('button', { name: 'Save payment' }))
    expect(dialog.getByText('The most you can enter is ₹10,00,000.')).toBeInTheDocument()
  })

  it('gently checks an amount far above the fee, without blocking', async () => {
    const { user, dialog } = await openFromHeader()
    dialog.getByRole('combobox', { name: /Student/ }).focus()
    await user.keyboard('kiara')
    await user.click(await screen.findByRole('option', { name: /Kiara Fernandes/ }))
    await dialog.findByText('Due now: October 2026')
    const amount = dialog.getByLabelText('Amount')
    await user.clear(amount)
    await user.type(amount, '15000')
    expect(dialog.getByText('That’s much more than the ₹1,500 fee. Is it right?')).toBeVisible()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Payment saved')).toBeInTheDocument()
  })

  it('shows Undo that removes the payment, even after the form has closed', async () => {
    const { user, dialog } = await openFromHeader()
    dialog.getByRole('combobox', { name: /Student/ }).focus()
    await user.keyboard('kiara')
    await user.click(await screen.findByRole('option', { name: /Kiara Fernandes/ }))
    await dialog.findByText('Due now: October 2026')
    await user.keyboard('{Enter}')
    const before = mockDb.payments.length
    await user.click(await screen.findByRole('button', { name: 'Undo' }))
    expect(await screen.findByText('Payment removed')).toBeInTheDocument()
    expect(mockDb.payments).toHaveLength(before - 1)
  })

  it('moves focus to the "Yet to pay" heading after saving from a row', async () => {
    const user = userEvent.setup()
    renderApp('/')
    const list = within(
      (await screen.findByRole('heading', { name: /Yet to pay/ })).closest('section')!,
    )
    await user.click(list.getByRole('button', { name: 'Log payment for Kabir Mehta' }))
    await findDialog('Log a payment')
    await user.keyboard('{Enter}')
    await screen.findByText('Payment saved')
    await waitFor(() => expect(screen.getByRole('heading', { name: /Yet to pay/ })).toHaveFocus())
  })

  describe('the month picker', () => {
    async function openForZara() {
      const { user, dialog } = await openFromHeader()
      dialog.getByRole('combobox', { name: /Student/ }).focus()
      await user.keyboard('zara')
      await user.click(await screen.findByRole('option', { name: /Zara Khan/ }))
      await dialog.findByText(/Next due|Due now|Oldest unpaid|All paid up/)
      return { user, dialog }
    }

    it('opens on the chosen month, so the arrow keys work straight away', async () => {
      const { user, dialog } = await openForZara()
      await user.click(dialog.getByLabelText(/^For month:/))
      // Zara has paid September and October, so November is suggested and chosen.
      expect(dialog.getByLabelText(/^For month:/)).toHaveTextContent('November 2026')
      await waitFor(() =>
        expect(document.activeElement).toHaveAttribute('aria-label', 'November 2026'),
      )
      await user.keyboard('{ArrowLeft}')
      expect(document.activeElement).toHaveAttribute('aria-label', 'October 2026')
    })

    it('skips greyed-out months and says why they are greyed out', async () => {
      // Zara joined in September 2026: nothing before it can be picked.
      const { user, dialog } = await openForZara()
      await user.click(dialog.getByLabelText(/^For month:/))
      expect(
        await screen.findByText(/Months before September 2026 are greyed out/),
      ).toBeInTheDocument()
      const september = screen.getByRole('button', { name: 'September 2026' })
      september.focus()
      await user.keyboard('{ArrowLeft}') // August and earlier are disabled
      expect(september).toHaveFocus()
      await user.keyboard('{ArrowUp}')
      expect(september).toHaveFocus()
      await user.keyboard('{ArrowRight}')
      expect(screen.getByRole('button', { name: 'October 2026' })).toHaveFocus()
    })
  })
})
