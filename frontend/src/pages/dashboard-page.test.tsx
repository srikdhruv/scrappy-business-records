import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { allPaidFixture, emptyFixture } from '@/mocks/fixtures'
import { mockDb } from '@/mocks/node'
import { findDialog, renderApp, TEST_NOW, withMockApi } from '@/test/render'

async function yetToPay() {
  const heading = await screen.findByRole('heading', { name: /Yet to pay/ })
  return within(heading.closest('section')!)
}

describe('dashboard', () => {
  describe('with the demo data', () => {
    withMockApi()

    it('shows this month, the summary and who is yet to pay', async () => {
      renderApp('/')
      // With no month chosen, the server's current month is shown.
      expect(
        await screen.findByRole('heading', { level: 1, name: 'October 2026' }),
      ).toBeInTheDocument()
      const list = await yetToPay()
      expect(list.getByRole('link', { name: 'Kabir Mehta' })).toBeInTheDocument()
      expect(list.getByRole('link', { name: 'Diya Sharma' })).toBeInTheDocument()
      // Paid in full this month, so not listed.
      expect(list.queryByRole('link', { name: 'Ananya Rao' })).not.toBeInTheDocument()
      // Aarav paid for September and October at once: October is paid.
      expect(list.queryByRole('link', { name: 'Aarav Gupta' })).not.toBeInTheDocument()

      const summary = screen.getByRole('group', { name: 'Summary' })
      expect(within(summary).getByText('Expected')).toBeInTheDocument()
      expect(within(summary).getByText('Still due')).toBeInTheDocument()
      expect(within(summary).getByText('6')).toBeInTheDocument() // not fully paid
    })

    it('lists earlier months still owed, where extra money went, and credit', async () => {
      renderApp('/')
      const backlog = within(
        (await screen.findByRole('heading', { name: /Earlier months still owed/ })).closest(
          'section',
        )!,
      )
      expect(
        backlog.getByRole('link', { name: /Rohan Kulkarni owes ₹3,000 from 2 earlier months/ }),
      ).toBeInTheDocument()
      expect(backlog.getByText('Jul 2026')).toBeInTheDocument()
      // Aarav's September was paid by the extra on his October payment, so it isn't owed.
      expect(backlog.queryByRole('link', { name: /Aarav Gupta/ })).not.toBeInTheDocument()

      const used = within(
        screen.getByRole('heading', { name: /Extra money used/ }).closest('section')!,
      )
      const aarav = used.getByRole('link', { name: /Aarav Gupta/ })
      expect(aarav).toHaveTextContent(/₹1,500 extra from the \d+ Oct 2026 payment for Oct 2026/)
      expect(aarav).toHaveTextContent('Sep 2026')

      // Dev left; ₹200 of his last payment wasn't needed by any month.
      const credit = within(
        screen.getByRole('heading', { name: /Extra kept as credit/ }).closest('section')!,
      )
      expect(credit.getByRole('link', { name: /Dev Malhotra/ })).toHaveTextContent('+₹200')
    })

    it('logs a payment from the dashboard: prefilled, saved, and the list updates', async () => {
      const user = userEvent.setup()
      renderApp('/')
      const list = await yetToPay()
      await user.click(list.getByRole('button', { name: 'Log payment for Kabir Mehta' }))

      const dialog = await findDialog('Log a payment')
      expect(dialog.getByRole('combobox', { name: /Student/ })).toHaveTextContent('Kabir Mehta')
      expect(dialog.getByLabelText('Amount')).toHaveValue('1500')
      expect(dialog.getByLabelText(/^For month:/)).toHaveTextContent('October 2026')
      // He also owes September, and the form says so.
      expect(await dialog.findByText('Oldest unpaid: September 2026')).toBeInTheDocument()

      await user.type(dialog.getByLabelText('Amount'), '{Enter}')

      expect(await screen.findByText('Payment saved')).toBeInTheDocument()
      await waitFor(() =>
        expect(list.queryByRole('link', { name: 'Kabir Mehta' })).not.toBeInTheDocument(),
      )
      expect(mockDb.payments.at(-1)).toMatchObject({
        amount_paise: 150000,
        for_month: '2026-10',
        paid_on: '2026-10-15',
        method: 'upi',
      })
    })

    it('can switch the payment to the oldest unpaid month', async () => {
      const user = userEvent.setup()
      renderApp('/')
      const list = await yetToPay()
      await user.click(list.getByRole('button', { name: 'Log payment for Rohan Kulkarni' }))
      const dialog = await findDialog('Log a payment')
      await user.click(await dialog.findByRole('button', { name: 'Pay July instead' }))
      expect(dialog.getByLabelText(/^For month:/)).toHaveTextContent('July 2026')
    })

    it('shows a future month calmly: not due yet, nothing owed', async () => {
      renderApp('/?month=2026-11')
      expect(
        await screen.findByRole('heading', { level: 1, name: 'November 2026' }),
      ).toBeInTheDocument()
      const summary = within(await screen.findByRole('group', { name: 'Summary' }))
      expect(summary.getByText('Not due yet')).toBeInTheDocument()
      expect(summary.queryByText('Still due')).not.toBeInTheDocument()
      expect(summary.getByText('Nothing to follow up yet')).toBeInTheDocument()
      const list = within(
        screen.getByRole('heading', { name: /Not paid ahead yet/ }).closest('section')!,
      )
      expect(list.queryByText('Unpaid')).not.toBeInTheDocument()
      expect(list.getAllByText('Not due yet').length).toBeGreaterThan(0)
    })

    it('explains why Collected differs from what was logged for the month', async () => {
      renderApp('/')
      const summary = within(await screen.findByRole('group', { name: 'Summary' }))
      // Aarav's ₹3,000 for October: ₹1,500 of it paid September.
      expect(summary.getByText('₹1,500 logged for October paid other months.')).toBeInTheDocument()
    })

    it('says when Collected includes extra money from other months', async () => {
      renderApp('/?month=2026-09')
      expect(
        await screen.findByText('Includes ₹1,500 of extra money from other months’ payments.'),
      ).toBeInTheDocument()
    })

    it('shows one row per payment, however many months it paid, and flags a likely typo', async () => {
      const student = mockDb.createStudent({
        name: 'Tanu Test',
        monthly_fee_paise: 150000,
        joined_month: '2026-10',
      })
      mockDb.createPayment({
        student_id: student.id,
        amount_paise: 4500000, // ₹45,000: an extra zero or two?
        paid_on: '2026-10-05',
        for_month: '2026-10',
        method: 'upi',
      })
      renderApp('/')
      const used = within(
        (await screen.findByRole('heading', { name: /Extra money used/ })).closest('section')!,
      )
      const rows = used.getAllByRole('link', { name: /Tanu Test/ })
      expect(rows).toHaveLength(1)
      expect(rows[0]).toHaveTextContent('Nov 2026 to Oct 2028')
      expect(rows[0]).toHaveTextContent('Check: this ₹45,000 payment pays up to Oct 2028')
    })

    it('shows the month that extra money paid, looking back', async () => {
      renderApp('/?month=2026-09')
      const used = within(
        (await screen.findByRole('heading', { name: /Extra money used/ })).closest('section')!,
      )
      expect(used.getByRole('link', { name: /Aarav Gupta/ })).toHaveTextContent('Sep 2026')
      const list = await yetToPay()
      expect(list.queryByRole('link', { name: 'Aarav Gupta' })).not.toBeInTheDocument()
    })

    it('moves between months', async () => {
      const user = userEvent.setup()
      renderApp('/')
      await yetToPay()
      await user.click(screen.getByRole('button', { name: /Previous month/ }))
      expect(screen.getByRole('heading', { level: 1, name: 'September 2026' })).toBeInTheDocument()
      await user.click(await screen.findByRole('button', { name: 'Back to October 2026' }))
      expect(screen.getByRole('heading', { level: 1, name: 'October 2026' })).toBeInTheDocument()
    })
  })

  describe('when everyone has paid', () => {
    withMockApi(() => allPaidFixture(TEST_NOW))

    it('celebrates', async () => {
      renderApp('/')
      expect(await screen.findByText('Everyone’s paid for October!')).toBeInTheDocument()
      expect(screen.getByText('Nothing owed from earlier months.')).toBeInTheDocument()
      // Nothing moved and nothing is kept: those sections aren't shown at all.
      expect(screen.queryByRole('heading', { name: /Extra money used/ })).not.toBeInTheDocument()
      expect(
        screen.queryByRole('heading', { name: /Extra kept as credit/ }),
      ).not.toBeInTheDocument()
    })
  })

  describe('on first run', () => {
    withMockApi(emptyFixture)

    it('guides to adding the first student', async () => {
      const user = userEvent.setup()
      renderApp('/')
      expect(await screen.findByText('Welcome! Let’s add your first student.')).toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'New student' }))
      expect(await findDialog('New student')).toBeTruthy()
    })
  })

  describe('when the app can’t be reached', () => {
    withMockApi()

    it('warns, over numbers already on screen, that they may be out of date', async () => {
      const { queryClient } = renderApp('/')
      await yetToPay()
      expect(screen.queryByText(/may be out of date/)).not.toBeInTheDocument()
      vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
      await queryClient.refetchQueries({ queryKey: ['health', 'ping'] })
      expect(await screen.findByText(/may be out of date/)).toBeInTheDocument()
      // The last numbers are still there, under the warning.
      expect(screen.getByRole('group', { name: 'Summary' })).toBeInTheDocument()
      vi.unstubAllGlobals()
    })

    it('says so in plain words', async () => {
      vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
      renderApp('/')
      expect(
        await screen.findByText(
          'Can’t reach Scrappy Records. Try closing and reopening it from the Desktop.',
        ),
      ).toBeInTheDocument()
      vi.unstubAllGlobals()
    })
  })
})
