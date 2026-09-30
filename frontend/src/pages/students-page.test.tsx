import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { mockDb } from '@/mocks/node'
import { findDialog, renderApp, withMockApi } from '@/test/render'

withMockApi()

async function studentRows() {
  const table = await screen.findByRole('table')
  return within(table)
}

/** Pick `option` in one of the table's dropdowns ("Show", "Group by", "Batch"…). */
async function choose(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string | RegExp,
) {
  await user.click(screen.getByRole('combobox', { name: new RegExp(`^${label}:`) }))
  await user.click(await screen.findByRole('option', { name: option }))
}

describe('students page', () => {
  it('lists active students with status and how long they have been coming', async () => {
    renderApp('/students')
    const rows = await studentRows()
    const kabir = rows.getByRole('link', { name: 'Kabir Mehta' }).closest('tr')!
    expect(within(kabir).getByText('Owes ₹3,000')).toBeInTheDocument()
    // Whole months since joining (the server's tenure_months): November 2025 to October 2026.
    expect(within(kabir).getByText('11 mo')).toBeInTheDocument()
    expect(within(kabir).getByText('Since Nov 2025')).toBeInTheDocument()
    // Their batch, with its days and times.
    expect(
      within(kabir).getByRole('link', { name: 'Mon/Wed 6pm – Koramangala' }),
    ).toBeInTheDocument()
    expect(within(kabir).getByText('Mon, Wed · 6:00–7:00 pm')).toBeInTheDocument()
    const ananya = rows.getByRole('link', { name: 'Ananya Rao' }).closest('tr')!
    expect(within(ananya).getByText('Up to date')).toBeInTheDocument()
    expect(within(ananya).getByText('1 yr 2 mo')).toBeInTheDocument()
    const meera = rows.getByRole('link', { name: 'Meera Iyer' }).closest('tr')!
    // She paid November early: she's up to date, and paid ahead (not "credit").
    expect(within(meera).getByText('Up to date')).toBeInTheDocument()
    expect(within(meera).getByText('Paid ahead ₹2,000')).toBeInTheDocument()
    // Students who left only show when asked for.
    expect(rows.queryByRole('link', { name: 'Dev Malhotra' })).not.toBeInTheDocument()
  })

  it('filters by Active / Left and the search box', async () => {
    const user = userEvent.setup()
    renderApp('/students')
    await studentRows()
    await choose(user, 'Show', /^Left/)
    let rows = await studentRows()
    expect(rows.getByRole('link', { name: 'Dev Malhotra' })).toBeInTheDocument()
    expect(rows.queryByRole('link', { name: 'Kabir Mehta' })).not.toBeInTheDocument()

    await choose(user, 'Show', /^Everyone/)
    await user.type(screen.getByRole('searchbox', { name: 'Search students' }), 'mehta')
    rows = await studentRows()
    expect(rows.getAllByRole('row')).toHaveLength(2) // header + Kabir
    expect(rows.getByRole('link', { name: 'Kabir Mehta' })).toBeInTheDocument()
  })

  it('searches like Log payment: any word order, accents, phone numbers without spaces', async () => {
    mockDb.createStudent({
      name: 'Émile Dsouza',
      monthly_fee_paise: 150000,
      joined_month: '2026-10',
      phone: '98765-43210',
    })
    const user = userEvent.setup()
    renderApp('/students')
    await studentRows()
    const search = screen.getByRole('searchbox', { name: 'Search students' })
    const names = async () =>
      (await studentRows())
        .queryAllByRole('link')
        .filter((link) => link.getAttribute('href')?.match(/^\/students\/\d+$/))
        .map((link) => link.textContent)

    for (const [typed, expected] of [
      ['kabir', ['Kabir Mehta']],
      ['mehta kabir', ['Kabir Mehta']],
      ['nair ARJUN', ['Arjun Nair']],
      ['9000000004', ['Arjun Nair']], // saved as "90000 00004"
      ['90000-00004', ['Arjun Nair']],
      ['emile', ['Émile Dsouza']],
      ['9876543210', ['Émile Dsouza']],
    ] as const) {
      await user.clear(search)
      await user.type(search, typed)
      await waitFor(async () => expect(await names()).toEqual(expected))
    }
    await user.clear(search)
    await user.type(search, 'kabir arjun')
    expect(await screen.findByText('No students match “kabir arjun”.')).toBeInTheDocument()
  })

  it('opens the first match with Enter', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/students')
    await studentRows()
    await user.type(screen.getByRole('searchbox', { name: 'Search students' }), 'kabir{Enter}')
    const id = mockDb.students.find((s) => s.name === 'Kabir Mehta')!.id
    await waitFor(() => expect(router.state.location.pathname).toBe(`/students/${id}`))
  })

  it('highlights the row Enter opens, and never opens one the filters hide', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/students')
    await studentRows()
    const search = screen.getByRole('searchbox', { name: 'Search students' })
    await user.type(search, 'mehta')
    const rows = await studentRows()
    const kabir = rows.getByRole('link', { name: 'Kabir Mehta' }).closest('tr')!
    expect(kabir).toHaveAttribute('data-next')
    expect(within(kabir).getByText('Enter opens')).toBeInTheDocument()

    // Dev Malhotra has left: hidden by Show: Active, so Enter does nothing.
    await user.clear(search)
    await user.type(search, 'malhotra{Enter}')
    expect(router.state.location.pathname).toBe('/students')
    await user.click(screen.getByRole('button', { name: 'Show them' }))
    await user.type(search, '{Enter}')
    const id = mockDb.students.find((s) => s.name === 'Dev Malhotra')!.id
    await waitFor(() => expect(router.state.location.pathname).toBe(`/students/${id}`))
  })

  it('puts the search above the batch cards, and folds them away while searching', async () => {
    const user = userEvent.setup()
    renderApp('/students')
    await studentRows()
    const search = screen.getByRole('searchbox', { name: 'Search students' })
    const cards = screen.getByRole('heading', { name: /^Batches/ })
    // The search box comes first on the page.
    expect(search.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await user.type(search, 'kabir')
    expect(screen.queryByRole('heading', { name: /^Batches/ })).not.toBeInTheDocument()
    expect(screen.getByText(/folded away while you search/)).toBeInTheDocument()
    await user.clear(search)
    expect(await screen.findByRole('heading', { name: /^Batches/ })).toBeInTheDocument()
  })

  it('moves ticked students to a batch at once, shift-click ticking a run', async () => {
    const user = userEvent.setup()
    for (const name of ['Asha One', 'Bina Two', 'Chitra Three']) {
      mockDb.createStudent({ name, monthly_fee_paise: 100000, joined_month: '2026-10' })
    }
    renderApp('/students/batch/none')
    const rows = await studentRows()
    await user.click(rows.getAllByRole('checkbox', { name: 'Tick Asha One' })[0]!)
    await user.keyboard('{Shift>}')
    await user.click(rows.getAllByRole('checkbox', { name: 'Tick Chitra Three' })[0]!)
    await user.keyboard('{/Shift}')
    expect(screen.getAllByText('3 students ticked')[0]).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Move to batch…' })[0]!)
    const dialog = await findDialog(/Move 3 students to a batch/)
    await user.click(dialog.getByRole('combobox', { name: /^Batch:/ }))
    await user.click(await screen.findByRole('option', { name: /Sat 10am – HSR Layout/ }))
    const sat = mockDb.batches.find((b) => b.name === 'Sat 10am – HSR Layout')!
    const fees = ['Asha One', 'Bina Two', 'Chitra Three'].map(
      (n) => mockDb.getStudent(mockDb.students.find((s) => s.name === n)!.id).fee_history,
    )
    await user.click(dialog.getByRole('button', { name: /^Move to Sat 10am/ }))
    expect(await screen.findByText('3 students moved to Sat 10am – HSR Layout')).toBeInTheDocument()
    ;['Asha One', 'Bina Two', 'Chitra Three'].forEach((n, i) => {
      const s = mockDb.students.find((x) => x.name === n)!
      expect(s.batch_id).toBe(sat.id)
      expect(mockDb.getStudent(s.id).fee_history).toEqual(fees[i]) // fees don't change
    })
  })

  it('says when the filters hide someone who matches', async () => {
    const user = userEvent.setup()
    renderApp('/students')
    await studentRows()
    await user.type(screen.getByRole('searchbox', { name: 'Search students' }), 'dev')
    expect(
      await screen.findByText(/1 more student matches “dev” but is hidden/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show them' }))
    expect((await studentRows()).getByRole('link', { name: 'Dev Malhotra' })).toBeInTheDocument()
  })

  it('creates a student, with the batch’s fee filled in', async () => {
    const user = userEvent.setup()
    renderApp('/students')
    await studentRows()
    await user.click(screen.getByRole('button', { name: 'New student' }))
    const dialog = await findDialog('New student')

    // Nothing filled in: explain what's missing.
    await user.click(dialog.getByRole('button', { name: 'Add student' }))
    expect(dialog.getByText('Enter their name.')).toBeInTheDocument()
    expect(dialog.getByText('Enter the monthly fee.')).toBeInTheDocument()
    expect(dialog.getByLabelText(/^Joined in:/)).toHaveTextContent('October 2026')

    await user.type(dialog.getByLabelText('Name'), 'Ishaan Kapoor')
    await user.click(dialog.getByRole('combobox', { name: 'Batch: No batch' }))
    await user.type(await screen.findByPlaceholderText('Type a batch, place or day…'), 'hsr')
    await user.click(await screen.findByRole('option', { name: /Sat 10am – HSR Layout/ }))
    expect(dialog.getByLabelText('Monthly fee')).toHaveValue('1800')
    await user.type(dialog.getByLabelText(/Phone/), '90000 00099{Enter}')

    expect(await screen.findByText('Ishaan Kapoor added')).toBeInTheDocument()
    const rows = await studentRows()
    const row = (await rows.findByRole('link', { name: 'Ishaan Kapoor' })).closest('tr')!
    expect(within(row).getByText('₹1,800')).toBeInTheDocument()
    expect(within(row).getByText('New this month')).toBeInTheDocument()
    const sat = mockDb.batches.find((b) => b.name === 'Sat 10am – HSR Layout')!
    expect(mockDb.students.at(-1)).toMatchObject({
      name: 'Ishaan Kapoor',
      joined_month: '2026-10',
      phone: '90000 00099',
      batch_id: sat.id,
      batch_label: null,
      guardian_name: null,
    })
  })

  it('never replaces a fee someone typed when a batch is picked', async () => {
    const user = userEvent.setup()
    renderApp('/students')
    await studentRows()
    await user.click(screen.getByRole('button', { name: 'New student' }))
    const dialog = await findDialog('New student')
    await user.type(dialog.getByLabelText('Monthly fee'), '1200')
    await user.click(dialog.getByRole('combobox', { name: 'Batch: No batch' }))
    await user.click(await screen.findByRole('option', { name: /Sat 10am – HSR Layout/ }))
    expect(dialog.getByLabelText('Monthly fee')).toHaveValue('1200')
    expect(dialog.getByText('Sat 10am – HSR Layout usually charges ₹1,800.')).toBeInTheDocument()
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
