/**
 * End-to-end tests (`make e2e`): the real production server (`python -m app`) serving the built
 * UI (`make build`), on a free port, with a throwaway data folder. Nothing here touches
 * ./.devdata or a real install. Feedback goes to a fake relay on another free port
 * (e2e/fake-relay.mjs), never to the internet, and the update check asks that relay's stand-in
 * for GitHub's latest release.
 */
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

const here = path.dirname(fileURLToPath(import.meta.url))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

// Worked out once, in the main process; test workers inherit them through the environment.
process.env.E2E_PORT ??= String(await freePort())
process.env.E2E_HOME ??= mkdtempSync(path.join(tmpdir(), 'scrappy-e2e-'))
process.env.E2E_RELAY_PORT ??= String(await freePort())

const port = process.env.E2E_PORT
const home = process.env.E2E_HOME
const baseURL = `http://127.0.0.1:${port}`
const relayURL = `http://127.0.0.1:${process.env.E2E_RELAY_PORT}`

export default defineConfig({
  testDir: './e2e',
  // One server and one database: run the tests one after another.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: {
    baseURL,
    locale: 'en-IN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: [
    {
      command: `node e2e/fake-relay.mjs ${process.env.E2E_RELAY_PORT}`,
      cwd: here,
      url: `${relayURL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'uv run --project ../backend python -m app',
      cwd: here,
      url: `${baseURL}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        SCRAPPY_HOME: home,
        SCRAPPY_BACKUP_DIR: path.join(home, 'backups'),
        SCRAPPY_PORT: port,
        SCRAPPY_FEEDBACK_URL: `${relayURL}/feedback`,
        // The update check asks the fake relay's stand-in for GitHub, never the internet.
        SCRAPPY_UPDATE_FEED_URL: `${relayURL}/releases/latest`,
        SCRAPPY_TEST_MODE: '1', // plain http to the fake feed is only allowed in test mode
      },
      // The server's request log is only worth reading when CI fails.
      stdout: 'ignore',
      stderr: process.env.CI ? 'pipe' : 'ignore',
    },
  ],
})
