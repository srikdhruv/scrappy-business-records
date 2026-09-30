import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { mockApi, renderApp } from '@/test/render'

beforeEach(() => {
  mockApi({ '/api/health': { app: 'scrappy-records', version: '0.1.0', status: 'ok' } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('app shell', () => {
  it('shows the name, navigation, Log payment button and version', async () => {
    renderApp('/')
    expect(screen.getByText('Scrappy Records')).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    for (const label of ['Dashboard', 'Payments', 'Students']) {
      expect(nav).toHaveTextContent(label)
    }
    expect(screen.getByRole('button', { name: /log payment/i })).toBeInTheDocument()
    expect(await screen.findByText('Version 0.1.0')).toBeInTheDocument()
  })

  it.each([
    ['/', 'Dashboard'],
    ['/payments', 'Payments'],
    ['/students', 'Students'],
    ['/students/7', 'Student'],
    ['/nowhere', 'Page not found'],
  ])('routes %s to the %s page', (path, heading) => {
    renderApp(path)
    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
  })

  it('navigates between pages', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/')
    await user.click(screen.getByRole('link', { name: 'Students' }))
    expect(router.state.location.pathname).toBe('/students')
    expect(screen.getByRole('link', { name: 'Students' })).toHaveAttribute('aria-current', 'page')
  })

  it('opens the Log payment placeholder', async () => {
    const user = userEvent.setup()
    renderApp('/')
    await user.click(screen.getByRole('button', { name: /log payment/i }))
    expect(await screen.findByText(/coming soon/i)).toBeInTheDocument()
  })
})
