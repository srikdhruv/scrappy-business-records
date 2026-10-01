import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { toast } from 'sonner'

import type { UpdateInfo } from '@/api/types'
import { resetUnsaved, setUnsaved } from '@/lib/unsaved'
import { page, POLL_MS } from '@/lib/update'
import { server } from '@/mocks/node'
import { findDialog, renderApp, TEST_NOW, withMockApi } from '@/test/render'

withMockApi()

const READY: UpdateInfo = {
  current: '0.2.0',
  latest: '0.3.0',
  update_available: true,
  notes: 'What’s new\n• Faster reports\n• A button to update the app',
  checked_at: '2026-10-15T04:00:00Z',
  can_update: true,
  reason: null,
  check_error: null,
  last_attempt: null,
  page_waiting: false,
  log_file: 'C:\\Users\\Demo\\AppData\\Local\\ScrappyRecords\\logs\\update.log',
}
const STARTED = {
  from_version: '0.2.0',
  to_version: '0.3.0',
  started_at: '2026-10-15T04:30:00+00:00',
  finished_at: null,
  outcome: 'running' as const,
  detail: '',
  technical: '',
  records_restored: false,
}

/** The server: `info` from GET /api/update, and what health says (changeable). */
function serve(info: UpdateInfo, health = { version: '0.2.0' }) {
  const requests: { path: string; headers: Headers; body: unknown }[] = []
  let current = info
  server.use(
    http.get('*/api/update', () => HttpResponse.json(current)),
    http.get('*/api/health', () =>
      HttpResponse.json({ app: 'scrappy-records', version: health.version, status: 'ok' }),
    ),
    http.post('*/api/update/start', async ({ request }) => {
      requests.push({
        path: '/api/update/start',
        headers: request.headers,
        body: await request.json(),
      })
      current = { ...current, can_update: false, reason: 'updating', last_attempt: STARTED }
      return HttpResponse.json(current, { status: 202 })
    }),
    http.post('*/api/update/check', ({ request }) => {
      requests.push({ path: '/api/update/check', headers: request.headers, body: null })
      current = { ...current, checked_at: '2026-10-15T05:00:00Z' }
      return HttpResponse.json(current)
    }),
  )
  return {
    requests,
    health,
    set: (next: UpdateInfo) => {
      current = next
    },
  }
}

const banner = () => screen.findByRole('region', { name: 'New version' })

/** Let the page load and ask the server about updates. */
async function settle() {
  await screen.findAllByRole('button', { name: /^Settings/ })
  await new Promise((resolve) => setTimeout(resolve, 150))
}

beforeEach(() => {
  localStorage.clear()
  resetUnsaved()
})
afterEach(() => vi.restoreAllMocks())

describe('the new version banner', () => {
  it('says a new version is ready, with a dot on the gear', async () => {
    serve(READY)
    renderApp('/')
    const region = await banner()
    expect(region).toHaveTextContent('A new version (0.3.0) is ready.')
    expect(within(region).getByRole('button', { name: 'See what’s new' })).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: 'Update now' })).toBeInTheDocument()
    expect(screen.getAllByTestId('update-dot').length).toBeGreaterThan(0)
    expect(
      screen.getAllByRole('button', { name: 'Settings (a new version is ready)' }).length,
    ).toBeGreaterThan(0)
  })

  it('shows nothing when up to date, or when this copy can’t update itself', async () => {
    for (const info of [
      {
        ...READY,
        latest: '0.2.0',
        update_available: false,
        can_update: false,
        reason: 'up_to_date' as const,
      },
      { ...READY, can_update: false, reason: 'not_installed' as const },
    ]) {
      serve(info)
      const { unmount } = renderApp('/')
      await settle()
      expect(screen.queryByRole('region', { name: 'New version' })).not.toBeInTheDocument()
      expect(screen.queryByTestId('update-dot')).not.toBeInTheDocument()
      unmount()
    }
  })

  it('Not now hides it until the next version; the dot stays', async () => {
    serve(READY)
    const user = userEvent.setup()
    const { unmount } = renderApp('/')
    await user.click(within(await banner()).getByRole('button', { name: 'Not now' }))
    expect(screen.queryByRole('region', { name: 'New version' })).not.toBeInTheDocument()
    expect(screen.getAllByTestId('update-dot').length).toBeGreaterThan(0)
    unmount()
    renderApp('/')
    await settle()
    expect(screen.queryByRole('region', { name: 'New version' })).not.toBeInTheDocument()
  })

  it('comes back for a newer version after Not now', async () => {
    localStorage.setItem('scrappy-update-dismissed', '0.3.0')
    serve({ ...READY, latest: '0.4.0' })
    renderApp('/')
    expect(await banner()).toHaveTextContent('A new version (0.4.0) is ready.')
  })

  it('See what’s new shows the notes', async () => {
    serve(READY)
    const user = userEvent.setup()
    renderApp('/')
    await user.click(within(await banner()).getByRole('button', { name: 'See what’s new' }))
    const dialog = await findDialog('What’s new in version 0.3.0')
    expect(dialog.getByText(/Faster reports/)).toBeInTheDocument()
    expect(dialog.getByText('You have version 0.2.0.')).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Update now' }))
    await findDialog('Update to version 0.3.0?')
  })
})

describe('Update now', () => {
  async function openConfirm() {
    const user = userEvent.setup()
    renderApp('/')
    await user.click(within(await banner()).getByRole('button', { name: 'Update now' }))
    return { user, dialog: await findDialog('Update to version 0.3.0?') }
  }

  it('asks first, in plain words', async () => {
    serve(READY)
    const { dialog } = await openConfirm()
    expect(
      dialog.getByText(
        'Updating takes about a minute. Your records are kept and backed up first. The app will reopen by itself.',
      ),
    ).toBeInTheDocument()
    expect(dialog.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('warns when something typed isn’t saved', async () => {
    serve(READY)
    setUnsaved('a-form', true)
    const { dialog } = await openConfirm()
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Something you typed in a form isn’t saved yet. Save it first, or it will be lost when the app reopens.',
    )
  })

  it('starts it (as the app, once), shows Updating…, and reloads on the new version', async () => {
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {})
    const api = serve(READY)
    const { user, dialog } = await openConfirm()
    const button = dialog.getByRole('button', { name: 'Update now' })
    await user.dblClick(button)
    const screenEl = await screen.findByTestId('updating-screen')
    expect(screenEl).toHaveTextContent('Updating… the app will reopen in a minute')
    expect(screenEl).toHaveTextContent('Please leave this window open.')
    const starts = api.requests.filter((r) => r.path === '/api/update/start')
    expect(starts).toHaveLength(1)
    expect(starts[0]!.body).toEqual({ version: '0.3.0' })
    expect(starts[0]!.headers.get('X-Scrappy-Request')).toBe('1')
    expect(starts[0]!.headers.get('Content-Type')).toContain('application/json')
    // The new version comes up.
    api.health.version = '0.3.0'
    await waitFor(() => expect(reload).toHaveBeenCalled(), { timeout: POLL_MS * 3 })
  })

  it('says so, in plain words, when the update didn’t finish', async () => {
    const reload = vi.spyOn(page, 'reload').mockImplementation(() => {})
    const api = serve(READY)
    const { user, dialog } = await openConfirm()
    await user.click(dialog.getByRole('button', { name: 'Update now' }))
    await screen.findByTestId('updating-screen')
    api.set({
      ...READY,
      last_attempt: {
        ...STARTED,
        outcome: 'failed',
        finished_at: '2026-10-15T04:31:00Z',
        detail:
          'The update to version 0.3.0 didn’t finish, so you still have version 0.2.0. Your records are as they were.',
        technical: 'Details: The remote name could not be resolved',
      },
    })
    const alert = await screen.findByRole('alert', {}, { timeout: POLL_MS * 3 })
    expect(alert).toHaveTextContent('The update didn’t finish')
    expect(alert).toHaveTextContent('so you still have version 0.2.0')
    expect(alert).toHaveTextContent('Your records are safe.')
    expect(alert).toHaveTextContent(READY.log_file)
    // The installer's own words only in a small folded line, not in the message.
    const technical = within(alert).getByText('Details: The remote name could not be resolved')
    expect(technical.closest('details')).not.toHaveAttribute('open')
    expect(within(alert).getByText('Technical details')).toBeInTheDocument()
    await user.click(within(alert).getByRole('button', { name: 'Back to the app' }))
    expect(reload).toHaveBeenCalled()
  })

  it('shows the server’s answer when it can’t start', async () => {
    serve(READY)
    server.use(
      http.post('*/api/update/start', () =>
        HttpResponse.json(
          { detail: 'Couldn’t download the update. Nothing was changed.' },
          { status: 424 },
        ),
      ),
    )
    const { user, dialog } = await openConfirm()
    await user.click(dialog.getByRole('button', { name: 'Update now' }))
    expect(await dialog.findByRole('alert')).toHaveTextContent(
      'Couldn’t download the update. Nothing was changed.',
    )
    expect(screen.queryByTestId('updating-screen')).not.toBeInTheDocument()
  })

  it('never comes back for an update this window gave up on', async () => {
    localStorage.setItem('scrappy-update-settled', JSON.stringify([STARTED.started_at]))
    serve({ ...READY, can_update: false, reason: 'updating', last_attempt: STARTED })
    renderApp('/')
    await settle()
    expect(screen.queryByTestId('updating-screen')).not.toBeInTheDocument()
  })

  it('an update started in another window shows here too', async () => {
    serve({ ...READY, can_update: false, reason: 'updating', last_attempt: STARTED })
    renderApp('/')
    expect(await screen.findByTestId('updating-screen')).toHaveTextContent(
      'Installing version 0.3.0',
    )
  })
})

describe('About', () => {
  async function openAbout() {
    const user = userEvent.setup()
    renderApp('/')
    await user.click(screen.getAllByRole('button', { name: /^Settings/ })[0]!)
    const item = await screen.findByRole('menuitem', { name: /About/ })
    await user.click(item)
    return { user, dialog: await findDialog('About Scrappy Records') }
  }

  it('shows the newest version, Check for updates and Update now', async () => {
    const api = serve(READY)
    const { user, dialog } = await openAbout()
    expect(await dialog.findByTestId('update-status')).toHaveTextContent(
      'Version 0.3.0 is ready to install.',
    )
    expect(dialog.getByText(/^Last checked \d+ Oct 2026, \d\d:\d\d\.$/)).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Check for updates' }))
    await waitFor(() => expect(api.requests.map((r) => r.path)).toContain('/api/update/check'))
    expect(api.requests[0]!.headers.get('X-Scrappy-Request')).toBe('1')
    await user.click(dialog.getByRole('button', { name: 'Update now' }))
    await findDialog('Update to version 0.3.0?')
  })

  it('up to date, offline, and switched off', async () => {
    const api = serve({
      ...READY,
      latest: '0.2.0',
      update_available: false,
      can_update: false,
      reason: 'up_to_date',
    })
    const { dialog, user } = await openAbout()
    expect(await dialog.findByTestId('update-status')).toHaveTextContent(
      'You have the newest version.',
    )
    expect(dialog.queryByRole('button', { name: 'Update now' })).not.toBeInTheDocument()
    api.set({
      ...READY,
      latest: null,
      update_available: false,
      checked_at: null,
      can_update: false,
      reason: 'check_failed',
      check_error: 'offline',
    })
    server.use(
      http.post('*/api/update/check', () =>
        HttpResponse.json({
          ...READY,
          latest: null,
          update_available: false,
          checked_at: null,
          can_update: false,
          reason: 'check_failed',
          check_error: 'offline',
        }),
      ),
    )
    await user.click(dialog.getByRole('button', { name: 'Check for updates' }))
    await waitFor(() =>
      expect(dialog.getByTestId('update-status')).toHaveTextContent(
        'Couldn’t check just now. Is the internet on?',
      ),
    )
  })

  it('says when checking is off, without the button', async () => {
    serve({
      ...READY,
      latest: null,
      update_available: false,
      checked_at: null,
      can_update: false,
      reason: 'checks_off',
    })
    const { dialog } = await openAbout()
    expect(await dialog.findByTestId('update-status')).toHaveTextContent(
      'This copy of the app doesn’t look for new versions.',
    )
    expect(dialog.queryByRole('button', { name: 'Check for updates' })).not.toBeInTheDocument()
  })
})

describe('an update that was cut short', () => {
  const FAILED = {
    ...STARTED,
    outcome: 'failed' as const,
    finished_at: '2026-10-15T04:40:00Z',
    detail:
      'The update to version 0.3.0 didn’t finish, so you still have version 0.2.0. Your records are as they were.',
    technical: 'No word from the installer for 30 minutes.',
  }

  it('says so once, with Try again', async () => {
    serve({ ...READY, last_attempt: FAILED })
    const user = userEvent.setup()
    const { unmount } = renderApp('/')
    const notice = await screen.findByRole('region', { name: 'The last update' })
    expect(notice).toHaveTextContent('The last update didn’t finish — your records are safe.')
    expect(notice).toHaveTextContent('You still have version 0.2.0')
    expect(notice).not.toHaveTextContent('installer')
    await user.click(within(notice).getByRole('button', { name: 'Try again' }))
    await findDialog('Update to version 0.3.0?')
    unmount()
    renderApp('/')
    await settle()
    expect(screen.queryByRole('region', { name: 'The last update' })).not.toBeInTheDocument()
    expect(await banner()).toHaveTextContent('A new version (0.3.0) is ready.')
  })

  it('says the records were put back when the installer did so', async () => {
    serve({ ...READY, last_attempt: { ...FAILED, records_restored: true } })
    renderApp('/')
    const notice = await screen.findByRole('region', { name: 'The last update' })
    expect(notice).toHaveTextContent(
      'The last update didn’t finish — your records were put back as they were before the update.',
    )
  })

  it('OK closes it, and the new-version banner comes back', async () => {
    serve({ ...READY, last_attempt: FAILED })
    const user = userEvent.setup()
    renderApp('/')
    const notice = await screen.findByRole('region', { name: 'The last update' })
    await user.click(within(notice).getByRole('button', { name: 'OK' }))
    expect(screen.queryByRole('region', { name: 'The last update' })).not.toBeInTheDocument()
    expect(await banner()).toBeInTheDocument()
  })

  it('isn’t said again after the Updating screen already said it', async () => {
    localStorage.setItem('scrappy-update-settled', JSON.stringify([FAILED.started_at]))
    serve({ ...READY, last_attempt: FAILED })
    renderApp('/')
    await settle()
    expect(screen.queryByRole('region', { name: 'The last update' })).not.toBeInTheDocument()
  })
})

describe('after the update', () => {
  it('says "Updated" once', async () => {
    const finished = new Date(TEST_NOW.getTime() - 60_000).toISOString()
    serve({
      ...READY,
      current: '0.3.0',
      latest: '0.3.0',
      update_available: false,
      can_update: false,
      reason: 'up_to_date',
      last_attempt: { ...STARTED, outcome: 'succeeded', finished_at: finished },
    })
    const { unmount } = renderApp('/')
    expect(
      await screen.findByText('Updated to version 0.3.0. Your records are just as you left them.'),
    ).toBeInTheDocument()
    unmount()
    toast.dismiss()
    renderApp('/')
    await settle()
    expect(screen.queryByText(/Updated to version 0.3.0/)).not.toBeInTheDocument()
  })
})
