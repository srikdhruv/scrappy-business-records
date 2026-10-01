/// <reference types="vitest/config" />
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const here = path.dirname(fileURLToPath(import.meta.url))

// The API server started by `make dev` (uvicorn on 127.0.0.1:8765).
const API_TARGET = process.env.SCRAPPY_API_URL ?? 'http://127.0.0.1:8765'

/**
 * `npm run dev:mock` needs MSW's service worker at /mockServiceWorker.js. Serve it straight from
 * node_modules on the dev server only, instead of keeping it in public/, so it can never end up
 * in the production build.
 */
function mockServiceWorker(): Plugin {
  return {
    name: 'scrappy-mock-service-worker',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/mockServiceWorker.js', (_req, res) => {
        const file = createRequire(import.meta.url).resolve('msw/mockServiceWorker.js')
        res.setHeader('Content-Type', 'text/javascript')
        res.end(readFileSync(file))
      })
    },
  }
}

/**
 * The commit the UI is built from (CI's GITHUB_SHA, else `git rev-parse HEAD`), baked in as
 * `__UI_BUILD__`. Feedback carries it next to the server's build ID, so a UI left over in a
 * browser from an older version can be told apart.
 */
function uiBuildId(): string {
  const sha = process.env.GITHUB_SHA?.trim()
  if (sha && /^[0-9a-f]{40}$/.test(sha)) return sha
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim()
    return /^[0-9a-f]{40}$/.test(head) ? head : 'unknown'
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), mockServiceWorker()],
  define: { __UI_BUILD__: JSON.stringify(uiBuildId()) },
  resolve: {
    alias: { '@': path.resolve(here, 'src') },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // The server only answers requests addressed to itself (backend/app/local_only.py):
      // present them as coming from its own address, not from Vite's :5173.
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            if (proxyReq.getHeader('origin')) proxyReq.setHeader('origin', API_TARGET)
          })
        },
      },
    },
  },
  build: {
    // The backend serves the built UI from its package, so it ships inside the bundle.
    outDir: path.resolve(here, '../backend/app/static'),
    emptyOutDir: true,
    // One bundle is fine: the app is served from the same laptop, never over the internet.
    chunkSizeWarningLimit: 1000,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // Whole-page tests render real tables of ~250 rows in jsdom; CI machines need headroom.
    testTimeout: 20_000,
  },
})
