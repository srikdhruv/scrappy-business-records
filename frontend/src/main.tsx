import './index.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import { installErrorListeners } from './lib/diagnostics'

// Remember script errors for feedback (Settings → Send feedback → "What gets sent").
installErrorListeners()

/**
 * `npm run dev:mock` answers /api from an in-memory mock (src/mocks) instead of the backend.
 * `import.meta.env.DEV` is `false` in production builds, so the bundler drops this branch and the
 * mock code (and MSW) never ships.
 */
async function startMockApiIfEnabled() {
  if (import.meta.env.DEV && import.meta.env.VITE_USE_MOCKS === 'true') {
    const { startMockApi } = await import('./mocks/browser')
    await startMockApi()
  }
}

void startMockApiIfEnabled().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
