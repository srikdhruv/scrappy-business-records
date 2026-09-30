import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { mockDb } from '@/mocks/node'
import { plural } from '@/lib/labels'
import { findDialog, renderApp, withMockApi } from '@/test/render'

withMockApi()

const SAT = 'Sat 10am – HSR Layout'
const MON_WED = 'Mon/Wed 6pm – Koramangala'

const batchId = (name: string) => mockDb.batches.find((b) => b.name === name)!.id
const tabs = () => within(screen.getByRole('navigation', { name: 'Batches' }))

async function choose(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string | RegExp,
) {
  await user.click(screen.getByRole('combobox', { name: new RegExp(`^${label}:`) }))
  await user.click(await screen.findByRole('option', { name: option }))
}

describe('batches on the Students page', () => {
  it('has a tab for every batch, and No batch, that are links', async () => {
    renderApp('/students')
    await screen.findByRole('heading', { name: /^Batches/ })
    const links = tabs().getAllByRole('link')
    expect(links.map((l) => l.textContent)).toEqual([
      expect.stringMatching(/^All batches/),
      expect.stringMatching(/^Mon\/Wed 6pm/),
      expect.stringMatching(/^Sat 10am/),
      expect.stringMatching(/^Sun 11am Kids/),
      expect.stringMatching(/^Tue\/Thu 5pm/),
      expect.stringMatching(/^No batch/),
    ])
    expect(links[0]).toHaveAttribute('aria-current', 'page')
    expect(links[2]).toHaveAttribute('href', `/students/batch/${batchId(SAT)}`)
    expect(links.at(-1)).toHaveAttribute('href', '/students/batch/none')
  })

  it('moves between tabs with the arrow keys', async () => {
    const user = userEvent.setup()
    renderApp('/students')
    await screen.findByRole('heading', { name: /^Batches/ })
    const links = tabs().getAllByRole('link')
    links[0]!.focus()
    await user.keyboard('{ArrowRight}')
    expect(links[1]).toHaveFocus()
    await user.keyboard('{End}')
    expect(links.at(-1)).toHaveFocus()
    await user.keyboard('{Home}')
    expect(links[0]).toHaveFocus()
  })

  it('shows a card per batch with how much of the month is paid', async () => {
    renderApp('/students')
    const card = (await screen.findByRole('article', { name: MON_WED })) as HTMLElement
    const c = within(card)
    expect(c.getByText('Koramangala')).toBeInTheDocument()
    expect(c.getByText('Mon, Wed · 6:00–7:00 pm')).toBeInTheDocument()
    const summary = (await mockDb.batchOverview('2026-10')).batches.find(
      (s) => s.batch_id === batchId(MON_WED),
    )!
    expect(await c.findByText(`${summary.paid_percent}%`)).toBeInTheDocument()
    expect(c.getByRole('link', { name: MON_WED })).toHaveAttribute(
      'href',
      `/students/batch/${batchId(MON_WED)}`,
    )
  })

  it('opens a batch: its details, the month’s numbers and its students', async () => {
    renderApp(`/students/batch/${batchId(SAT)}`)
    expect(await screen.findByRole('heading', { level: 2, name: SAT })).toBeInTheDocument()
    expect(
      screen.getByText(/HSR Layout · Sat · 10:00–11:30 am · Usual fee ₹1,800/),
    ).toBeInTheDocument()
    expect(tabs().getByRole('link', { current: 'page' })).toHaveTextContent(SAT)
    const summary = mockDb
      .batchOverview('2026-10')
      .batches.find((s) => s.batch_id === batchId(SAT))!
    expect(await screen.findByText(`${summary.paid_percent}%`)).toBeInTheDocument()
    const table = within(await screen.findByRole('table'))
    const inSat = mockDb.students.filter((s) => s.batch_id === batchId(SAT) && !s.left_month)
    for (const s of inSat) expect(table.getByRole('link', { name: s.name })).toBeInTheDocument()
    // No batch column on a batch's own tab.
    expect(table.queryByRole('columnheader', { name: /Batch/ })).not.toBeInTheDocument()
  })

  it('adds a student from a batch’s tab, with the batch chosen and its fee filled in', async () => {
    const user = userEvent.setup()
    renderApp(`/students/batch/${batchId(SAT)}`)
    await screen.findByRole('heading', { level: 2, name: SAT })
    await user.click(screen.getAllByRole('button', { name: 'Add student' })[0]!)
    const dialog = await findDialog('New student')
    expect(dialog.getByRole('combobox', { name: `Batch: ${SAT}` })).toBeInTheDocument()
    await waitFor(() => expect(dialog.getByLabelText('Monthly fee')).toHaveValue('1800'))
    await user.type(dialog.getByLabelText('Name'), 'Tara Singh{Enter}')
    expect(await screen.findByText('Tara Singh added')).toBeInTheDocument()
    const table = within(await screen.findByRole('table'))
    expect(await table.findByRole('link', { name: 'Tara Singh' })).toBeInTheDocument()
    expect(mockDb.students.at(-1)).toMatchObject({ batch_id: batchId(SAT) })
  })

  it('creates a batch and opens its tab', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/students')
    await screen.findByRole('heading', { name: /^Batches/ })
    await user.click(screen.getByRole('button', { name: 'New batch' }))
    const dialog = await findDialog('New batch')
    await user.click(dialog.getByRole('button', { name: 'Add batch' }))
    expect(dialog.getByText('Give the batch a name.')).toBeInTheDocument()
    await user.type(dialog.getByLabelText('Name'), 'Friday Beginners')
    await user.type(dialog.getByLabelText(/Location/), 'Whitefield')
    await user.click(dialog.getByRole('button', { name: 'Friday', pressed: false }))
    await user.type(dialog.getByLabelText(/Starts at/), '16:00')
    await user.type(dialog.getByLabelText(/Ends at/), '15:00')
    await user.type(dialog.getByLabelText(/Usual monthly fee/), '2,500')
    await user.click(dialog.getByRole('button', { name: 'Add batch' }))
    expect(dialog.getByText('The end time must be after the start time.')).toBeInTheDocument()
    await user.clear(dialog.getByLabelText(/Ends at/))
    await user.type(dialog.getByLabelText(/Ends at/), '17:00')
    await user.click(dialog.getByRole('button', { name: 'Add batch' }))

    expect(await screen.findByText('Friday Beginners added')).toBeInTheDocument()
    const made = mockDb.batches.at(-1)!
    expect(made).toMatchObject({
      name: 'Friday Beginners',
      location: 'Whitefield',
      days: ['fri'],
      start_time: '16:00',
      end_time: '17:00',
      default_fee_paise: 250000,
    })
    await waitFor(() => expect(router.state.location.pathname).toBe(`/students/batch/${made.id}`))
    expect(await screen.findByText('No students in this batch yet.')).toBeInTheDocument()
  })

  it('changes a batch’s fee for no one, unless ticked, and then only for those ticked', async () => {
    const user = userEvent.setup()
    const sat = batchId(SAT)
    // One pays their own (lower) fee; one has a discount planned for December.
    const own = mockDb.createStudent({
      name: 'Kiran Bose',
      monthly_fee_paise: 100000,
      joined_month: '2026-01',
      batch_id: sat,
    })
    const planned = mockDb.createStudent({
      name: 'Pia Planned',
      monthly_fee_paise: 180000,
      joined_month: '2026-01',
      batch_id: sat,
    })
    mockDb.updateStudent(planned.id, { monthly_fee_paise: 90000, fee_effective_month: '2026-12' })
    renderApp(`/students/batch/${sat}`)
    await screen.findByRole('heading', { level: 2, name: SAT })
    await user.click(screen.getByRole('button', { name: 'Edit batch' }))
    const dialog = await findDialog(`Edit ${SAT}`)
    const fee = dialog.getByLabelText(/Usual monthly fee/)
    await user.clear(fee)
    await user.type(fee, '2000')
    expect(
      dialog.getByText('Changing the usual fee doesn’t change what anyone in this batch pays.'),
    ).toBeInTheDocument()
    await user.click(
      dialog.getByRole('checkbox', { name: 'Also charge ₹2,000 to students in this batch' }),
    )
    expect(dialog.getByLabelText(/^New fee from:/)).toHaveTextContent('October 2026')
    // Ticked at first: only those on the usual ₹1,800.
    const kiran = await dialog.findByRole('checkbox', { name: /Kiran Bose/ })
    expect(kiran).not.toBeChecked()
    const pia = dialog.getByRole('checkbox', { name: /Pia Planned/ })
    expect(pia).not.toBeChecked()
    expect(
      dialog.getByText(/until December 2026, when ₹900 \(already scheduled\) starts/),
    ).toBeInTheDocument()
    const onFee = mockDb.students.filter(
      (s) =>
        s.batch_id === sat &&
        !s.left_month &&
        s.id !== planned.id &&
        mockDb.getStudent(s.id).monthly_fee_paise === 180000,
    )
    for (const s of onFee) {
      expect(dialog.getByRole('checkbox', { name: new RegExp(s.name) })).toBeChecked()
    }
    // Untick one of them: exactly the ticked ones change.
    const [skipped, ...charged] = onFee
    await user.click(dialog.getByRole('checkbox', { name: new RegExp(skipped!.name) }))
    expect(
      dialog.getByText(`${plural(charged.length, 'student')} will pay ₹2,000 from October 2026`, {
        exact: false,
      }),
    ).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Save changes' }))
    expect(await screen.findByText('Batch saved')).toBeInTheDocument()

    for (const s of charged) {
      expect(mockDb.getStudent(s.id).fee_history.at(-1)).toMatchObject({
        effective_month: '2026-10',
        amount_paise: 200000,
      })
    }
    expect(mockDb.getStudent(skipped!.id).monthly_fee_paise).toBe(180000)
    expect(mockDb.getStudent(own.id).fee_history).toHaveLength(1)
    expect(mockDb.getStudent(planned.id).fee_history.map((f) => f.amount_paise)).toEqual([
      180000, 90000,
    ])
  })

  it('warns what a month already due would owe', async () => {
    const user = userEvent.setup()
    const sat = batchId(SAT)
    renderApp(`/students/batch/${sat}`)
    await screen.findByRole('heading', { level: 2, name: SAT })
    await user.click(screen.getByRole('button', { name: 'Edit batch' }))
    const dialog = await findDialog(`Edit ${SAT}`)
    const fee = dialog.getByLabelText(/Usual monthly fee/)
    await user.clear(fee)
    await user.type(fee, '2000')
    await user.click(
      dialog.getByRole('checkbox', { name: 'Also charge ₹2,000 to students in this batch' }),
    )
    await dialog.findAllByRole('checkbox', { checked: true })
    await user.click(dialog.getByRole('button', { name: /^New fee from:/ }))
    await user.click(await screen.findByRole('button', { name: 'August 2026' }))
    const ticked = mockDb.students.filter(
      (s) =>
        s.batch_id === sat && !s.left_month && mockDb.getStudent(s.id).monthly_fee_paise === 180000,
    )
    // August to October: 3 months already due, ₹200 more each for every ticked student.
    const warning = await dialog.findByRole('alert')
    expect(warning).toHaveTextContent('3 months already due (August–October 2026) change')
    expect(warning).toHaveTextContent(
      `owe ₹${(ticked.length * 3 * 200).toLocaleString('en-IN')} more for them in total`,
    )
  })

  it('deletes a batch after saying what happens to its students', async () => {
    const user = userEvent.setup()
    const sat = batchId(SAT)
    const members = mockDb.students.filter((s) => s.batch_id === sat)
    const left = members.filter((s) => s.left_month && s.left_month < '2026-10').length
    const { router } = renderApp(`/students/batch/${sat}`)
    await screen.findByRole('heading', { level: 2, name: SAT })
    await user.click(screen.getByRole('button', { name: `Delete ${SAT}` }))
    const dialog = within(await screen.findByRole('alertdialog', { name: `Delete ${SAT}?` }))
    expect(
      dialog.getByText(
        `Its ${members.length} students${left ? `, including ${left} who ${left === 1 ? 'has' : 'have'} left,` : ''} aren’t deleted: they all move to No batch.`,
      ),
    ).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Delete batch' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/students'))
    expect(mockDb.batches.some((b) => b.id === sat)).toBe(false)
    for (const s of members) expect(mockDb.students.find((x) => x.id === s.id)?.batch_id).toBeNull()

    await user.click(tabs().getByRole('link', { name: /^No batch/ }))
    const table = within(await screen.findByRole('table'))
    const active = members.find((s) => !s.left_month)!
    expect(await table.findByRole('link', { name: active.name })).toBeInTheDocument()
  })

  it('turns old labels into batches after showing what it will do', async () => {
    const user = userEvent.setup()
    for (const [name, label] of [
      ['Ravi Kumar', 'Thu 7pm Adults'],
      ['Leela Das', 'thu 7PM  adults'],
      ['Mohan Rao', 'Thu 7pm Adults'],
    ]) {
      mockDb.createStudent({
        name: name!,
        monthly_fee_paise: 150000,
        joined_month: '2026-09',
        batch_label: label,
      })
    }
    renderApp('/students')
    await user.click(
      await screen.findByRole('button', { name: 'Create batches from existing labels' }),
    )
    const dialog = await findDialog('Create batches from existing labels')
    expect(dialog.getByText(/1 new batch from 3 students/)).toBeInTheDocument()
    expect(dialog.getByText('Leela Das, Mohan Rao, Ravi Kumar')).toBeInTheDocument()
    expect(dialog.queryByText(/nobody coming now/)).not.toBeInTheDocument()
    expect(mockDb.batches.some((b) => b.name === 'Thu 7pm Adults')).toBe(false) // not yet
    await user.click(dialog.getByRole('button', { name: 'Create 1 batch' }))
    expect(await screen.findByText('1 batch created')).toBeInTheDocument()
    const made = mockDb.batches.find((b) => b.name === 'Thu 7pm Adults')!
    expect(mockDb.students.filter((s) => s.batch_id === made.id).map((s) => s.batch_label)).toEqual(
      ['Thu 7pm Adults', 'thu 7PM  adults', 'Thu 7pm Adults'],
    )
    expect(mockDb.backups).toHaveLength(1)
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Create batches from existing labels' }),
      ).not.toBeInTheDocument(),
    )
  })

  it('groups and filters every student', async () => {
    const user = userEvent.setup()
    renderApp('/students')
    await screen.findByRole('table')
    await choose(user, 'Group by', 'Batch')
    const table = within(screen.getByRole('table'))
    expect(table.getByRole('heading', { name: MON_WED })).toBeInTheDocument()
    expect(table.getByRole('heading', { name: SAT })).toBeInTheDocument()

    await choose(user, 'Location', 'Koramangala')
    await waitFor(() => expect(table.queryByRole('heading', { name: SAT })).not.toBeInTheDocument())
    expect(table.getByRole('heading', { name: MON_WED })).toBeInTheDocument()
    const kabir = mockDb.students.find((s) => s.name === 'Kabir Mehta')!
    expect(table.getByRole('link', { name: kabir.name })).toBeInTheDocument()

    await choose(user, 'Day', 'Saturday')
    expect(await screen.findByText('No students match these filters.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(
      await within(await screen.findByRole('table')).findByRole('heading', { name: SAT }),
    ).toBeInTheDocument()
  })

  it('sorts by a column heading', async () => {
    const user = userEvent.setup()
    renderApp('/students')
    const table = within(await screen.findByRole('table'))
    await user.click(table.getByRole('button', { name: 'Monthly fee' }))
    expect(table.getByRole('columnheader', { name: /Monthly fee/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
    const fees = table
      .getAllByRole('row')
      .slice(1)
      .map((row) => within(row).getAllByRole('cell')[3]!.textContent!) // after the tick box
      .map((text) => Number(text.replace(/[^\d]/g, '').slice(0, 4)))
    expect(fees).toEqual([...fees].sort((a, b) => b - a))
  })

  it('says so when a batch no longer exists', async () => {
    renderApp('/students/batch/99999')
    expect(await screen.findByText('This batch doesn’t exist any more.')).toBeInTheDocument()
  })
})
