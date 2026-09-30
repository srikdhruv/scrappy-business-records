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

      const summary = screen.getByRole('group', { name: 'Summary' })
      expect(within(summary).getByText('Expected')).toBeInTheDocument()
      expect(within(summary).getByText('Still due')).toBeInTheDocument()
      expect(within(summary).getByText('7')).toBeInTheDocument() // not fully paid
    })

    it('lists earlier months still owed and overpayments', async () => {
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

      const overpaid = within(
        screen.getByRole('heading', { name: /Paid too much/ }).closest('section')!,
      )
      expect(overpaid.getByText('+₹300')).toBeInTheDocument()
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

    it('says how much extra someone paid, and in which month', async () => {
      renderApp('/')
      const list = await yetToPay()
      // Aarav owes part of October but paid ₹1,500 too much in March.
      expect(list.getByText('Paid ₹1,500 extra in Mar 2026')).toBeInTheDocument()
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
