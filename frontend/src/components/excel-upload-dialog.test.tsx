import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'

import type {
  ImportCommit,
  ImportPaymentPreview,
  ImportPreview,
  ImportStudentPreview,
} from '@/api/types'
import { mockDb, server } from '@/mocks/node'
import { findDialog, renderApp, withMockApi } from '@/test/render'

withMockApi()

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function student(
  row: number,
  name: string,
  status: ImportStudentPreview['status'],
  extra: Partial<ImportStudentPreview> = {},
): ImportStudentPreview {
  return {
    row,
    sheet: 'Students',
    name,
    phone: null,
    monthly_fee_paise: 150000,
    joined_month: '2026-10',
    status,
    reason: null,
    student_id: null,
    add_by_default: false,
    data:
      status === 'problem'
        ? null
        : {
            row,
            name,
            monthly_fee_paise: 150000,
            joined_month: '2026-10',
          },
    ...extra,
  }
}

function payment(
  row: number,
  who: string,
  status: ImportPaymentPreview['status'],
  extra: Partial<ImportPaymentPreview> = {},
): ImportPaymentPreview {
  return {
    row,
    sheet: 'Payments',
    student_text: who,
    amount_paise: 150000,
    paid_on: '2026-10-05',
    for_month: '2026-10',
    method: 'upi',
    note: null,
    status,
    reason: null,
    student_id: null,
    student_row: null,
    candidate_ids: [],
    data:
      status === 'problem'
        ? null
        : {
            row,
            student_text: who,
            amount_paise: 150000,
            paid_on: '2026-10-05',
            for_month: '2026-10',
            method: 'upi',
            unassigned: false,
          },
    ...extra,
  }
}

const idOf = (name: string) => mockDb.students.find((s) => s.name === name)!.id

function thePreview(): ImportPreview {
  const kabir = idOf('Kabir Mehta')
  const ananya = idOf('Ananya Rao')
  return {
    filename: 'october.xlsx',
    sheets: ['Students', 'Payments'],
    ignored_sheets: ['Notes'],
    hidden_sheets: [],
    fee_changes: 0,
    current_month: '2026-10',
    students: [
      student(2, 'Ishaan Kapoor', 'new'),
      student(3, 'Ananya Rao', 'exists', {
        reason: 'Already here: Ananya Rao',
        student_id: ananya,
      }),
      student(4, 'Kabir Mehta', 'similar', {
        phone: '90000 00077',
        reason: 'Same name as Kabir Mehta, but a different phone',
        student_id: kabir,
      }),
      student(5, '', 'problem', { reason: 'Name is missing' }),
    ],
    payments: [
      payment(2, 'Ishaan Kapoor', 'ready', { student_row: 2 }),
      payment(3, 'Ananya Rao', 'ready', { student_id: ananya }),
      payment(4, 'K Mehta', 'needs_student', {
        reason: 'No student called “K Mehta”. Choose who paid, or keep it as unassigned',
        candidate_ids: [kabir],
      }),
      payment(5, 'Someone', 'needs_student', { reason: 'No student called “Someone”' }),
      payment(6, 'Ananya Rao', 'duplicate', {
        reason: 'Already logged: ₹1,500 paid on 5 Oct 2026 for Oct 2026',
      }),
    ],
  }
}

/** Answer the preview with `preview`, and record what Add sends. */
function answerPreview(preview: () => ImportPreview) {
  const uploads: { type: string | null; size: number; filename: string | null }[] = []
  const commits: ImportCommit[] = []
  server.use(
    http.post('*/api/import/preview', async ({ request }) => {
      const body = await request.arrayBuffer()
      uploads.push({
        type: request.headers.get('content-type'),
        size: body.byteLength,
        filename: new URL(request.url).searchParams.get('filename'),
      })
      return HttpResponse.json(preview())
    }),
    http.post('*/api/import/commit', async ({ request }) => {
      commits.push((await request.clone().json()) as ImportCommit)
      return HttpResponse.json({
        students_added: 1,
        fee_changes_added: 1,
        payments_added: 3,
        unassigned_added: 1,
        skipped: 3,
        backup_file: 'records-pre-import-20261015-100000.db',
      })
    }),
  )
  return { uploads, commits }
}

async function openUpload(path: string) {
  const user = userEvent.setup()
  renderApp(path)
  await user.click(await screen.findByRole('button', { name: 'Upload Excel' }))
  const dialog = await findDialog('Upload Excel')
  return { user, dialog }
}

const file = () => new File(['PK fake xlsx'], 'october.xlsx', { type: XLSX })

describe('Upload Excel', () => {
  it('offers a blank template before a file is chosen', async () => {
    const { dialog } = await openUpload('/students')
    const link = dialog.getByRole('link', { name: 'Download a blank template' })
    expect(link).toHaveAttribute('href', '/api/import/template.xlsx?kind=students')
    expect(dialog.getByText(/Nothing already here is changed/)).toBeInTheDocument()
  })

  it('previews, lets the owner choose, and adds', async () => {
    const { uploads, commits } = answerPreview(thePreview)
    const { user, dialog } = await openUpload('/students')
    await user.upload(dialog.getByLabelText('Excel file to upload'), file())

    const summary = await dialog.findByTestId('upload-summary')
    expect(summary).toHaveTextContent(
      'Will add 1 student and 2 payments. 2 payments will be kept as unassigned, to give to a ' +
        'student later. 2 already exist and will be skipped. 3 need you to choose. 1 has a ' +
        'problem and will be skipped.',
    )
    expect(uploads).toEqual([{ type: XLSX, size: 12, filename: 'october.xlsx' }])
    expect(dialog.getByText(/“Notes”/)).toBeInTheDocument()
    expect(dialog.getByText('Name is missing')).toBeInTheDocument()
    expect(dialog.getByText('To Ishaan Kapoor (new, row 2)')).toBeInTheDocument()
    expect(dialog.getByText('To Ananya Rao')).toBeInTheDocument()

    // The look-alike: add as new.
    await user.click(dialog.getByRole('combobox', { name: 'What to do with Kabir Mehta (row 4)' }))
    await user.click(await screen.findByRole('option', { name: 'Add as new' }))
    // "K Mehta" is Kabir Mehta (the likely one); "Someone" is skipped.
    await user.click(dialog.getByRole('combobox', { name: 'Who paid row 4 (K Mehta)' }))
    await user.click(await screen.findByRole('option', { name: /^Kabir Mehta/ }))
    await user.click(dialog.getByRole('combobox', { name: 'Who paid row 5 (Someone)' }))
    await user.click(await screen.findByRole('option', { name: 'Skip' }))
    expect(summary).toHaveTextContent('Will add 2 students and 3 payments.')
    expect(summary).not.toHaveTextContent('unassigned')

    // Only rows that need a choice.
    await user.click(dialog.getByRole('tab', { name: 'To choose (3)' }))
    expect(dialog.queryByText('Ishaan Kapoor')).not.toBeInTheDocument()
    expect(dialog.getAllByText(/Mehta/).length).toBeGreaterThan(0)

    await user.click(dialog.getByRole('button', { name: 'Add' }))
    expect(
      await screen.findByText('Added 1 student, 3 payments and 1 unassigned payment'),
    ).toBeInTheDocument()
    expect(screen.getByText(/A backup was saved first/)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    const [sent] = commits
    expect(sent!.filename).toBe('october.xlsx')
    // Problem rows aren't sent; the look-alike is sent with add: true.
    expect(sent!.students.map((s) => [s.data.row, s.add])).toEqual([
      [2, undefined],
      [3, undefined],
      [4, true],
    ])
    expect(sent!.payments.map((p) => [p.data.row, p.choice, p.student_id])).toEqual([
      [2, 'auto', undefined],
      [3, 'auto', undefined],
      [4, 'student', idOf('Kabir Mehta')],
      [5, 'skip', undefined],
      [6, 'auto', undefined],
    ])
  })

  it('shows a plain message for a file it can’t read, and lets you choose another', async () => {
    server.use(
      http.post('*/api/import/preview', () =>
        HttpResponse.json(
          {
            detail: [
              { loc: ['body'], msg: 'This isn’t an Excel file (.xlsx).', type: 'value_error' },
            ],
          },
          { status: 422 },
        ),
      ),
    )
    const { user, dialog } = await openUpload('/payments')
    await user.upload(dialog.getByLabelText('Excel file to upload'), file())
    expect(await dialog.findByRole('alert')).toHaveTextContent('This isn’t an Excel file (.xlsx).')
    expect(dialog.getByRole('button', { name: 'Choose a file' })).toBeInTheDocument()
    expect(dialog.getByRole('link', { name: 'Download a blank template' })).toHaveAttribute(
      'href',
      '/api/import/template.xlsx?kind=payments',
    )
  })

  it('possible duplicates can be added anyway; siblings are added unless skipped', async () => {
    const ananya = idOf('Ananya Rao')
    const { commits } = answerPreview(() => ({
      ...thePreview(),
      ignored_sheets: [],
      hidden_sheets: ['Old list'],
      students: [
        student(2, 'Tara Iyer', 'new'),
        student(3, 'Meera Iyer', 'similar', {
          reason: 'Same phone as Tara Iyer (row 2), perhaps a brother or sister',
          add_by_default: true,
        }),
      ],
      payments: [
        payment(2, 'Ananya Rao', 'possible_duplicate', {
          student_id: ananya,
          reason: 'Possibly already logged: ₹1,500 paid on 5 Oct 2026 for Oct 2026, by Cash',
        }),
        payment(3, 'Ananya Rao', 'duplicate', {
          student_id: ananya,
          reason: 'Already logged: ₹1,500 paid on 5 Oct 2026 for Oct 2026',
        }),
      ],
    }))
    const { user, dialog } = await openUpload('/students')
    await user.upload(dialog.getByLabelText('Excel file to upload'), file())
    const summary = await dialog.findByTestId('upload-summary')
    expect(summary).toHaveTextContent(
      'Will add 2 students. 1 already exists and will be skipped. 2 need you to choose.',
    )
    expect(dialog.getByText(/Hidden sheets, not read: “Old list”/)).toBeInTheDocument()
    expect(
      dialog.getByRole('combobox', { name: 'What to do with Meera Iyer (row 3)' }),
    ).toHaveTextContent('Add as new')

    await user.click(dialog.getByRole('combobox', { name: 'What to do with row 2 (Ananya Rao)' }))
    await user.click(await screen.findByRole('option', { name: 'Add anyway' }))
    expect(summary).toHaveTextContent('Will add 2 students and 1 payment.')
    await user.click(dialog.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(commits).toHaveLength(1))
    expect(commits[0]!.students.map((s) => [s.data.row, s.add])).toEqual([
      [2, undefined],
      [3, undefined], // the server adds it by default too
    ])
    expect(commits[0]!.payments.map((p) => [p.data.row, p.choice])).toEqual([
      [2, 'add'],
      [3, 'auto'],
    ])
  })

  it('shows part of a very long file, and says so', async () => {
    answerPreview(() => ({
      ...thePreview(),
      students: [],
      payments: Array.from({ length: 450 }, (_, i) =>
        payment(i + 2, 'Ananya Rao', 'ready', { student_id: idOf('Ananya Rao') }),
      ),
    }))
    const { user, dialog } = await openUpload('/payments')
    await user.upload(dialog.getByLabelText('Excel file to upload'), file())
    expect(await dialog.findByTestId('upload-summary')).toHaveTextContent('Will add 450 payments.')
    expect(dialog.getByText(/…and 50 more rows, not shown here/)).toBeInTheDocument()
  })

  it('says when there is nothing new to add', async () => {
    answerPreview(() => ({
      ...thePreview(),
      ignored_sheets: [],
      students: [student(3, 'Ananya Rao', 'exists', { reason: 'Already here: Ananya Rao' })],
      payments: [payment(6, 'Ananya Rao', 'duplicate', { reason: 'Already logged' })],
    }))
    const { user, dialog } = await openUpload('/students')
    await user.upload(dialog.getByLabelText('Excel file to upload'), file())
    expect(await dialog.findByTestId('upload-summary')).toHaveTextContent(
      'Nothing new to add. 2 already exist and will be skipped.',
    )
    expect(dialog.getByRole('button', { name: 'Nothing to add' })).toBeDisabled()
  })

  it('adds through the mock API, and the Students page shows them at once', async () => {
    const { user, dialog } = await openUpload('/students')
    server.use(
      http.post('*/api/import/preview', () =>
        HttpResponse.json({
          ...thePreview(),
          students: [student(2, 'Ishaan Kapoor', 'new')],
          payments: [],
        }),
      ),
    )
    await user.upload(dialog.getByLabelText('Excel file to upload'), file())
    await dialog.findByTestId('upload-summary')
    await user.click(dialog.getByRole('button', { name: 'Add' }))
    expect(await screen.findByText('Added 1 student')).toBeInTheDocument()
    const table = within(screen.getByRole('table'))
    expect(await table.findByRole('link', { name: 'Ishaan Kapoor' })).toBeInTheDocument()
  })
})
