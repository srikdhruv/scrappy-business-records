import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { renderApp, withMockApi } from '@/test/render'

withMockApi()

describe('app shell', () => {
  it('shows the name, navigation, Log payment button and version', async () => {
    renderApp('/')
    expect(screen.getByText('Scrappy Records')).toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Main' })
    for (const label of ['Dashboard', 'Payments', 'Students']) {
      expect(nav).toHaveTextContent(label)
    }
    expect(screen.getByRole('button', { name: 'Log payment' })).toBeInTheDocument()
    expect(await screen.findByText('Version 0.1.0')).toBeInTheDocument()
  })

  it.each([
    ['/', 'October 2026'],
    ['/payments', 'Payments'],
    ['/students', 'Students'],
    ['/nowhere', 'Page not found'],
  ])('routes %s to the %s page', async (path, heading) => {
    renderApp(path)
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
  })

  it('opens a student profile', async () => {
    renderApp('/students/1')
    expect(await screen.findByRole('heading', { level: 1, name: 'Ananya Rao' })).toBeInTheDocument()
  })

  it('has a Log payment button on every page', async () => {
    for (const path of ['/', '/payments', '/students', '/students/1', '/nowhere']) {
      const { unmount } = renderApp(path)
      expect(screen.getByRole('button', { name: 'Log payment' })).toBeInTheDocument()
      unmount()
    }
  })

  it('navigates between pages', async () => {
    const user = userEvent.setup()
    const { router } = renderApp('/')
    await user.click(screen.getByRole('link', { name: 'Students' }))
    expect(router.state.location.pathname).toBe('/students')
    expect(screen.getByRole('link', { name: 'Students' })).toHaveAttribute('aria-current', 'page')
  })
})
