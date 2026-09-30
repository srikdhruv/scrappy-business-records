import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'

import type { FeedbackCreate } from '@/api/types'
import { clearErrors, recordError } from '@/lib/diagnostics'
import { captureScreen } from '@/lib/screenshot'
import { server } from '@/mocks/node'
import { findDialog, renderApp, withMockApi } from '@/test/render'

vi.mock('@/lib/screenshot', async (original) => ({
  ...(await original<typeof import('@/lib/screenshot')>()),
  captureScreen: vi.fn(),
}))

const PICTURE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=='

withMockApi()

beforeEach(() => {
  vi.mocked(captureScreen).mockResolvedValue({
    dataUrl: PICTURE,
    bytes: 13,
    width: 1280,
    height: 900,
  })
  clearErrors()
})

/** Record what the dialog sends, answering like the mock (pending, then sent). */
function captureRequests() {
  const sent: FeedbackCreate[] = []
  server.events.on('request:start', ({ request }) => {
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/feedback') {
      void request
        .clone()
        .json()
        .then((body) => sent.push(body as FeedbackCreate))
    }
  })
  return sent
}

async function openFeedback(path = '/payments?month=2026-10') {
  const user = userEvent.setup()
  renderApp(path)
  await user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!)
  await user.click(await screen.findByRole('menuitem', { name: 'Send feedback' }))
  const dialog = await findDialog('Send feedback')
  return { user, dialog }
}

afterEach(() => server.events.removeAllListeners())

describe('Send feedback', () => {
  it('opens from the gear, with a picture of the page behind it', async () => {
    const { dialog } = await openFeedback()
    expect(dialog.getByRole('radio', { name: 'Problem' })).toHaveAttribute('aria-checked', 'true')
    const box = dialog.getByRole('checkbox', { name: 'Include a picture of this screen' })
    expect(box).toBeChecked()
    expect(await dialog.findByRole('img', { name: 'Picture of this screen' })).toHaveAttribute(
      'src',
      PICTURE,
    )
    expect(dialog.getByText(/may show student names and amounts/)).toBeInTheDocument()
    expect(dialog.getByText(/private feedback inbox/)).toBeInTheDocument()
    expect(captureScreen).toHaveBeenCalledTimes(1)
  })

  it('sends the message, type, page, picture and details, then says Sent', async () => {
    recordError('api', 'GET /api/students → 500')
    const sent = captureRequests()
    const { user, dialog } = await openFeedback()
    await dialog.findByRole('img', { name: 'Picture of this screen' })
    await user.click(dialog.getByRole('radio', { name: 'Idea' }))
    await user.type(dialog.getByLabelText('Message'), '  Show last month too  ')
    await user.click(dialog.getByRole('button', { name: 'Send' }))

    expect(await screen.findByText('Sent ✓')).toBeInTheDocument()
    expect(screen.getByText(/The developer has it/)).toBeInTheDocument()
    await waitFor(() => expect(sent).toHaveLength(1))
    const body = sent[0]!
    expect(body).toMatchObject({
      category: 'idea',
      message: 'Show last month too',
      route: '/payments?month=2026-10',
      screenshot: PICTURE,
    })
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.client?.local_time).toMatch(/^2026-10-15T10:00:00[+-]\d\d:\d\d$/)
    expect(body.client?.errors).toEqual([
      expect.objectContaining({ kind: 'api', message: 'GET /api/students → 500' }),
    ])
  })

  it('leaves the picture out when the box is unticked', async () => {
    const sent = captureRequests()
    const { user, dialog } = await openFeedback()
    await dialog.findByRole('img', { name: 'Picture of this screen' })
    await user.click(dialog.getByRole('checkbox', { name: 'Include a picture of this screen' }))
    await user.type(dialog.getByLabelText('Message'), 'No picture please')
    await user.click(dialog.getByRole('button', { name: 'Send' }))
    await screen.findByText('Sent ✓')
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.screenshot).toBeNull()
  })

  it('asks for a message first', async () => {
    const sent = captureRequests()
    const { user, dialog } = await openFeedback()
    await dialog.findByRole('img', { name: 'Picture of this screen' })
    await user.click(dialog.getByRole('button', { name: 'Send' }))
    expect(dialog.getByText('Please write a message.')).toBeInTheDocument()
    expect(dialog.getByLabelText('Message')).toHaveAttribute('aria-invalid', 'true')
    expect(sent).toHaveLength(0)
  })

  it('says Saved when it could not be sent yet', async () => {
    server.use(
      http.get('*/api/feedback/:id', ({ params }) =>
        HttpResponse.json({
          id: String(params.id),
          category: 'problem',
          status: 'pending',
          created_at: '2026-10-15T10:00:00Z',
          sent_at: null,
          attempts: 1,
          sending: true,
        }),
      ),
    )
    const { user, dialog } = await openFeedback()
    await dialog.findByRole('img', { name: 'Picture of this screen' })
    await user.type(dialog.getByLabelText('Message'), 'Offline today')
    await user.click(dialog.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    expect(screen.getByText(/sent automatically when you’re online/)).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: 'Close' }).at(-1)!)
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('waits for a slow picture when Send is clicked early', async () => {
    let finish: (shot: Awaited<ReturnType<typeof captureScreen>>) => void = () => {}
    vi.mocked(captureScreen).mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const sent = captureRequests()
    const { user, dialog } = await openFeedback()
    expect(dialog.getByLabelText('Taking a picture of the screen')).toBeInTheDocument()
    await user.type(dialog.getByLabelText('Message'), 'Quick one')
    await user.click(dialog.getByRole('button', { name: 'Send' }))
    expect(dialog.getByRole('button', { name: 'Send' })).toBeDisabled()
    expect(sent).toHaveLength(0)
    finish({ dataUrl: PICTURE, bytes: 13, width: 1280, height: 900 })
    await screen.findByText('Sent ✓')
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.screenshot).toBe(PICTURE)
  })

  it('still sends when the picture could not be taken', async () => {
    vi.mocked(captureScreen).mockResolvedValue(null)
    const sent = captureRequests()
    const { user, dialog } = await openFeedback()
    expect(await dialog.findByText(/picture couldn’t be taken/)).toBeInTheDocument()
    expect(
      dialog.getByRole('checkbox', { name: 'Include a picture of this screen' }),
    ).toBeDisabled()
    await user.type(dialog.getByLabelText('Message'), 'It broke')
    await user.click(dialog.getByRole('button', { name: 'Send' }))
    await screen.findByText('Sent ✓')
    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]!.screenshot).toBeNull()
  })

  it('lists what gets sent, in plain words', async () => {
    const { dialog } = await openFeedback('/students')
    const details = dialog.getByText('What gets sent')
    expect(details.tagName).toBe('SUMMARY')
    expect(await dialog.findByText(/0\.1\.0, build 0000000/)).toBeInTheDocument()
    expect(dialog.getByText('/students')).toBeInTheDocument()
    expect(dialog.getByText(/Never/).closest('li')).toHaveTextContent(
      'Never your records file, backups or downloads.',
    )
  })
})

describe('About', () => {
  it('shows the version, build and where the data lives', async () => {
    const user = userEvent.setup()
    renderApp('/')
    await user.click(screen.getAllByRole('button', { name: 'Settings' })[0]!)
    await user.click(await screen.findByRole('menuitem', { name: 'About' }))
    const dialog = await findDialog('About Scrappy Records')
    expect(await dialog.findByText('0.1.0')).toBeInTheDocument()
    expect(dialog.getByText('000000000000')).toBeInTheDocument()
    expect(dialog.getByText(/ScrappyRecords\\data$/)).toBeInTheDocument()
    expect(dialog.getByText(/ScrappyRecords Backups$/)).toBeInTheDocument()
  })
})
