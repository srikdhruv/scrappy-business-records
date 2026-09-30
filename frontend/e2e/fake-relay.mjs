/**
 * A stand-in for the feedback relay (relay/, a Cloudflare Worker) for the end-to-end tests:
 * `node e2e/fake-relay.mjs <port>`. It answers like the real one and keeps what it was sent.
 *
 *   POST /feedback         201 {status: "created", issue_url}, or the next scripted answer
 *   GET  /received         every body it was sent, as a JSON array
 *   POST /script           queue answers: [{status, body}], used one per feedback POST
 *   GET  /health           {ok: true}
 *
 * It also stands in for GitHub's "latest release" (the update check, ADR 0006):
 *   GET  /releases/latest  404 (nothing released), or the release set with POST /feed
 *   POST /feed             {tag, body} sets the latest release; {} goes back to 404
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 8799)
const received = []
const script = []
const filed = new Map()
let release = null

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(data)
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true })
  if (req.method === 'GET' && url.pathname === '/releases/latest') {
    if (!release) return send(res, 404, { message: 'Not Found' })
    return send(res, 200, release)
  }
  if (req.method === 'POST' && url.pathname === '/feed') {
    const { tag, body } = JSON.parse(await readBody(req))
    release = tag
      ? {
          tag_name: tag,
          name: tag,
          draft: false,
          prerelease: false,
          body: body ?? '',
          assets: [
            { name: 'scrappy-records-windows-x64.zip', state: 'uploaded' },
            { name: 'scrappy-records-macos-arm64.zip', state: 'uploaded' },
          ],
        }
      : null
    return send(res, 200, { release })
  }
  if (req.method === 'GET' && url.pathname === '/received') return send(res, 200, received)
  if (req.method === 'POST' && url.pathname === '/script') {
    script.push(...JSON.parse(await readBody(req)))
    return send(res, 200, { queued: script.length })
  }
  if (req.method === 'POST' && url.pathname === '/feedback') {
    const payload = JSON.parse(await readBody(req))
    received.push(payload)
    const next = script.shift()
    if (next) return send(res, next.status, next.body)
    if (!filed.has(payload.id)) {
      filed.set(payload.id, `https://github.com/example/feedback/issues/${filed.size + 1}`)
    }
    return send(res, 201, { status: 'created', issue_url: filed.get(payload.id) })
  }
  send(res, 404, { status: 'not_found' })
}).listen(port, '127.0.0.1')
