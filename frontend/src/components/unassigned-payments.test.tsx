import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { UnassignedPaymentRead } from '@/api/types'
import type { Fixture } from '@/mocks/db'
import { demoFixture } from '@/mocks/fixtures'
import { mockDb } from '@/mocks/node'
import { renderApp, TEST_NOW, withMockApi } from '@/test/render'

function stray(id: number, fields: Partial<UnassignedPaymentRead> = {}): UnassignedPaymentRead {
  return {
    id,
    student_text: 'K Mehta',
    phone: null,
    amount_paise: 150000,
    paid_on: '2026-10-03',
    for_month: '2026-10',
    method: 'cash',
    note: 'from the bank list',
    source: 'Upload: october.xlsx',
    created_at: '2026-10-15T10:00:00Z',
    suggested_student_ids: [],
    ...fields,
  }
}

withMockApi((): Fixture => {
  const demo = demoFixture(TEST_NOW)
  const kabir = demo.students.find((s) => s.name === 'Kabir Mehta')!.id
  return {
    ...demo,
    unassigned: [
      stray(9001, { suggested_student_ids: [kabir] }),
      stray(9002, { student_text: 'Someone Else', amount_paise: 300000, method: 'upi' }),
    ],
  }
})

async function section() {
  const heading = await screen.findByRole('heading', { name: /Unassigned payments/ })
  return within(heading.closest('section')!)
}

describe('unassigned payments', () => {
  it('are listed at the top of the Payments page, as written', async () => {
    renderApp('/payments')
    const s = await section()
    expect(s.getByText(/aren’t counted for anyone/)).toBeInTheDocument()
    expect(s.getByText('2 payments, ₹4,500 in all.', { exact: false })).toBeInTheDocument()
    expect(s.getByText('K Mehta')).toBeInTheDocument()
    expect(s.getAllByText('from the bank list')).toHaveLength(2)
    expect(s.getAllByText(/Upload: october.xlsx/)).toHaveLength(2)
    expect(s.getByText(/Maybe: Kabir Mehta/)).toBeInTheDocument()
  })

  it('assign one to a student, suggested first', async () => {
    const user = userEvent.setup()
    renderApp('/payments')
    const s = await section()
    const kabir = mockDb.students.find((st) => st.name === 'Kabir Mehta')!
    const before = mockDb.payments.filter((p) => p.student_id === kabir.id).length

    const assign = s.getByRole('button', { name: 'Assign ₹1,500 from “K Mehta”' })
    expect(assign).toBeDisabled()
    await user.click(s.getByRole('combobox', { name: /Student who paid ₹1,500 from “K Mehta”/ }))
    const likely = await screen.findByRole('group', { name: 'Likely' })
    await user.click(within(likely).getByRole('option', { name: /Kabir Mehta/ }))
    await user.click(assign)

    expect(await screen.findByText('Payment assigned')).toBeInTheDocument()
    await waitFor(() => expect(s.queryByText('K Mehta')).not.toBeInTheDocument())
    expect(mockDb.payments.filter((p) => p.student_id === kabir.id)).toHaveLength(before + 1)
    expect(mockDb.unassigned.map((u) => u.id)).toEqual([9002])
  })

  it('says why when it would be a duplicate, and keeps it', async () => {
    const user = userEvent.setup()
    const kabir = mockDb.students.find((st) => st.name === 'Kabir Mehta')!
    mockDb.payments.push({
      id: 8001,
      student_id: kabir.id,
      amount_paise: 150000,
      paid_on: '2026-10-03',
      for_month: '2026-10',
      method: 'cash',
      note: null,
      created_at: '2026-10-03T10:00:00Z',
      updated_at: '2026-10-03T10:00:00Z',
    })
    renderApp('/payments')
    const s = await section()
    await user.click(s.getByRole('combobox', { name: /Student who paid ₹1,500 from “K Mehta”/ }))
    await user.click(await screen.findByRole('option', { name: /Kabir Mehta/ }))
    await user.click(s.getByRole('button', { name: 'Assign ₹1,500 from “K Mehta”' }))
    expect(await s.findByRole('alert')).toHaveTextContent('Kabir Mehta already has this payment')
    expect(mockDb.unassigned).toHaveLength(2)
  })

  it('delete asks first', async () => {
    const user = userEvent.setup()
    renderApp('/payments')
    const s = await section()
    await user.click(
      s.getByRole('button', { name: 'Delete unassigned payment: ₹3,000 from “Someone Else”' }),
    )
    const confirm = within(await screen.findByRole('alertdialog'))
    expect(confirm.getByText(/₹3,000 from “Someone Else” for October 2026/)).toBeInTheDocument()
    await user.click(confirm.getByRole('button', { name: 'Delete payment' }))
    expect(await screen.findByText('Unassigned payment deleted')).toBeInTheDocument()
    expect(mockDb.unassigned.map((u) => u.id)).toEqual([9001])
  })

  it('the Dashboard says they are waiting, with a link', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/')
    expect(
      await screen.findByText('2 payments (₹4,500) are waiting to be assigned to a student.'),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'Assign them' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/payments'))
    expect(router.state.location.hash).toBe('#unassigned-payments')
  })
})

describe('the monthly report', () => {
  withMockApi((): Fixture => ({
    ...demoFixture(TEST_NOW),
    unassigned: [
      stray(9001),
      stray(9002, { amount_paise: 300000 }),
      stray(9003, { for_month: '2026-09' }),
    ],
  }))

  it('says how much of the month is waiting for a student, with a way to it', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/report?month=2026-10')
    const line = await screen.findByTestId('report-unassigned')
    expect(line).toHaveTextContent(
      'Also ₹4,500 of payments not yet matched to a student (2 payments for October 2026 from an upload): not counted above.',
    )
    await user.click(within(line).getByRole('link', { name: 'Give them to a student' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/payments'))
    expect(router.state.location.hash).toBe('#unassigned-payments')
  })

  it('says nothing for a month with none waiting', async () => {
    renderApp('/report?month=2026-08')
    await screen.findByRole('table')
    expect(screen.queryByTestId('report-unassigned')).not.toBeInTheDocument()
  })
})

describe('with none waiting', () => {
  withMockApi()

  it('shows no section and no banner', async () => {
    renderApp('/payments')
    await screen.findByRole('table')
    expect(screen.queryByRole('heading', { name: /Unassigned payments/ })).not.toBeInTheDocument()
  })
})
