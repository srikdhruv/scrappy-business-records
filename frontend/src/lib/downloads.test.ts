import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { mockDb } from '@/mocks/node'
import { renderApp, withMockApi } from '@/test/render'

import { paymentsDownloadUrl, studentsDownloadUrl, templateUrl } from './downloads'
import { summarize, summarySentence } from './upload'

describe('download links', () => {
  it('students: the tab and the search', () => {
    expect(studentsDownloadUrl('active', '')).toBe('/api/export/students.xlsx?status=active')
    expect(studentsDownloadUrl('all', '  Émile d ')).toBe(
      '/api/export/students.xlsx?status=all&q=%C3%89mile+d',
    )
  })

  it('payments: the filters and the order', () => {
    expect(paymentsDownloadUrl({})).toBe('/api/export/payments.xlsx')
    expect(
      paymentsDownloadUrl({
        studentId: 4,
        month: '2026-10',
        q: 'gpay',
        method: 'cash',
        sort: { id: 'amount', desc: false },
      }),
    ).toBe(
      '/api/export/payments.xlsx?student_id=4&month=2026-10&q=gpay&method=cash&sort=amount&order=asc',
    )
    expect(paymentsDownloadUrl({ sort: { id: 'actions', desc: true } })).toBe(
      '/api/export/payments.xlsx',
    )
  })

  it('templates', () => {
    expect(templateUrl('payments')).toBe('/api/import/template.xlsx?kind=payments')
  })
})

describe('on the pages', () => {
  withMockApi()

  it('Students: Download Excel follows the tab and search', async () => {
    const user = userEvent.setup()
    renderApp('/students')
    const link = await screen.findByRole('link', { name: 'Download Excel' })
    expect(link).toHaveAttribute('href', '/api/export/students.xlsx?status=active')
    await user.click(screen.getByRole('tab', { name: /Left/ }))
    await user.type(screen.getByRole('searchbox', { name: 'Search students' }), 'rohan')
    expect(link).toHaveAttribute('href', '/api/export/students.xlsx?status=left&q=rohan')
    // Download everything is on the page too, not only in the side menu (hidden when narrow).
    for (const everything of screen.getAllByRole('link', { name: 'Download everything' })) {
      expect(everything).toHaveAttribute('href', '/api/export/everything.xlsx')
    }
    expect(screen.getAllByRole('link', { name: 'Download everything' })).toHaveLength(2)
  })

  it('Payments: Download Excel follows the filters and the sort', async () => {
    const user = userEvent.setup()
    const meera = mockDb.students.find((s) => s.name === 'Meera Iyer')!.id
    renderApp(`/payments?student=${meera}&method=cash`)
    const link = await screen.findByRole('link', { name: 'Download Excel' })
    expect(link).toHaveAttribute(
      'href',
      `/api/export/payments.xlsx?student_id=${meera}&method=cash&sort=paid_on&order=desc`,
    )
    const table = await screen.findByRole('table')
    const head = within(table.querySelector('thead')!)
    await user.click(head.getByRole('button', { name: 'Amount' }))
    expect(link.getAttribute('href')).toMatch(/sort=amount&order=(asc|desc)$/)
  })

  it('the side menu has Download everything', async () => {
    renderApp('/')
    expect(await screen.findByRole('link', { name: 'Download everything' })).toHaveAttribute(
      'href',
      '/api/export/everything.xlsx',
    )
  })
})

describe('the upload summary', () => {
  it('counts what will happen', () => {
    const s = summarize(
      {
        filename: null,
        sheets: [],
        ignored_sheets: [],
        hidden_sheets: [],
        student_counts: {},
        payment_counts: {},
        all_rows_shown: true,
        fee_changes: 0,
        current_month: '2026-10',
        students: [],
        payments: [],
      },
      { students: new Map(), payments: new Map() },
    )
    expect(summarySentence(s)).toBe('Nothing new to add.')
    expect(
      summarySentence({
        students: 12,
        payments: 140,
        unassigned: 0,
        alreadyHere: 3,
        toChoose: 2,
        problems: 0,
      }),
    ).toBe(
      'Will add 12 students and 140 payments. 3 already exist and will be skipped. 2 need you to choose.',
    )
  })
})
