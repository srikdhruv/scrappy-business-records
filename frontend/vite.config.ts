/// <reference types="vitest/config" />
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

export default defineConfig({
  plugins: [react(), tailwindcss(), mockServiceWorker()],
  resolve: {
    alias: { '@': path.resolve(here, 'src') },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
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
