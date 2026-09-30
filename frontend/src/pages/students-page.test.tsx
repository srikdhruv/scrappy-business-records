import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { mockDb } from '@/mocks/node'
import { findDialog, renderApp, withMockApi } from '@/test/render'

withMockApi()

async function studentRows() {
  const table = await screen.findByRole('table')
  return within(table)
}

describe('students page', () => {
  it('lists active students with status and how long they have been coming', async () => {
    renderApp('/students')
    const rows = await studentRows()
    const kabir = rows.getByRole('link', { name: 'Kabir Mehta' }).closest('tr')!
    expect(within(kabir).getByText('Owes ₹3,000')).toBeInTheDocument()
    expect(within(kabir).getByText('11 mo')).toBeInTheDocument()
    const ananya = rows.getByRole('link', { name: 'Ananya Rao' }).closest('tr')!
    expect(within(ananya).getByText('Up to date')).toBeInTheDocument()
    expect(within(ananya).getByText('1 yr 2 mo')).toBeInTheDocument()
    const meera = rows.getByRole('link', { name: 'Meera Iyer' }).closest('tr')!
    expect(within(meera).getByText('Credit ₹2,000')).toBeInTheDocument()
    // Students who left are on the Left tab.
    expect(rows.queryByRole('link', { name: 'Dev Malhotra' })).not.toBeInTheDocument()
  })

  it('filters with the tabs and the search box', async () => {
    const user = userEvent.setup()
    renderApp('/students')
    await studentRows()
    await user.click(screen.getByRole('tab', { name: /Left/ }))
    let rows = await studentRows()
    expect(rows.getByRole('link', { name: 'Dev Malhotra' })).toBeInTheDocument()
    expect(rows.queryByRole('link', { name: 'Kabir Mehta' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /All/ }))
    await user.type(screen.getByRole('searchbox', { name: 'Search students' }), 'mehta')
    rows = await studentRows()
    expect(rows.getAllByRole('row')).toHaveLength(2) // header + Kabir
    expect(rows.getByRole('link', { name: 'Kabir Mehta' })).toBeInTheDocument()
  })

  it('creates a student', async () => {
    const user = userEvent.setup()
    renderApp('/students')
    await studentRows()
    await user.click(screen.getByRole('button', { name: 'New student' }))
    const dialog = await findDialog('New student')

    // Nothing filled in: explain what's missing.
    await user.click(dialog.getByRole('button', { name: 'Add student' }))
    expect(dialog.getByText('Enter their name.')).toBeInTheDocument()
    expect(dialog.getByText('Enter the monthly fee.')).toBeInTheDocument()
    expect(dialog.getByLabelText('Joined in')).toHaveTextContent('October 2026')

    await user.type(dialog.getByLabelText('Name'), 'Ishaan Kapoor')
    await user.type(dialog.getByLabelText('Monthly fee'), '1,600')
    await user.type(dialog.getByLabelText(/Class or batch/), 'Sat 10am – HSR Layout')
    await user.type(dialog.getByLabelText(/Phone/), '98765 40000{Enter}')

    expect(await screen.findByText('Ishaan Kapoor added')).toBeInTheDocument()
    const rows = await studentRows()
    const row = (await rows.findByRole('link', { name: 'Ishaan Kapoor' })).closest('tr')!
    expect(within(row).getByText('₹1,600')).toBeInTheDocument()
    expect(within(row).getByText('New this month')).toBeInTheDocument()
    expect(mockDb.students.at(-1)).toMatchObject({
      name: 'Ishaan Kapoor',
      joined_month: '2026-10',
      phone: '98765 40000',
      batch_label: 'Sat 10am – HSR Layout',
      guardian_name: null,
    })
  })

  it('opens a profile when a row is clicked', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/students')
    const rows = await studentRows()
    const row = rows.getByRole('link', { name: 'Ananya Rao' }).closest('tr')!
    await user.click(within(row).getByText('Up to date'))
    const id = mockDb.students.find((st) => st.name === 'Ananya Rao')!.id
    await waitFor(() => expect(router.state.location.pathname).toBe(`/students/${id}`))
  })
})
