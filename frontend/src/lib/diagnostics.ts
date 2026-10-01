/**
 * What the feedback dialog attaches from the browser: when and where, and the last errors the
 * app noticed. Never anything from the records: API errors are kept as "GET /api/students →
 * 500" (the path only, no query or body).
 *
 * `installErrorListeners()` (main.tsx) and the API client's middleware (`api/client.ts`) feed
 * the ring buffer; `clientInfo()` reads it when feedback is sent.
 */
import type { FeedbackClientError, FeedbackClientInfo } from '@/api/types'

/** A fixed-size list that keeps the newest `capacity` items. */
export class RingBuffer<T> {
  private items: T[] = []
  readonly capacity: number

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity))
  }

  push(item: T) {
    this.items.push(item)
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity)
  }

  /** Oldest first. A copy, so callers can't change the buffer. */
  toArray(): T[] {
    return [...this.items]
  }

  clear() {
    this.items = []
  }

  get size() {
    return this.items.length
  }
}

export const ERROR_CAPACITY = 20
const MESSAGE_LIMIT = 1000

export type ErrorKind = 'error' | 'rejection' | 'api' | 'network'

const recent = new RingBuffer<FeedbackClientError>(ERROR_CAPACITY)

export function recordError(kind: ErrorKind, message: string, now = new Date()) {
  recent.push({ at: now.toISOString(), kind, message: message.slice(0, MESSAGE_LIMIT) })
}

export function recentErrors(): FeedbackClientError[] {
  return recent.toArray()
}

export function clearErrors() {
  recent.clear()
}

/** A readable one-liner for anything thrown. */
export function describeError(reason: unknown): string {
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`
  if (typeof reason === 'string') return reason
  try {
    return JSON.stringify(reason) ?? String(reason)
  } catch {
    return String(reason)
  }
}

/** Keep script errors and unhandled promise rejections. Returns a function that stops. */
export function installErrorListeners(target: Window = window): () => void {
  const onError = (event: ErrorEvent) => {
    const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : ''
    recordError('error', `${event.message || describeError(event.error)}${where}`)
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    recordError('rejection', describeError(event.reason))
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}

/** "GET /api/students → 500", from a request (the path only: queries can hold names). */
export function describeRequest(request: Request, outcome: string): string {
  let path = request.url
  try {
    path = new URL(request.url).pathname
  } catch {
    // keep the raw URL
  }
  return `${request.method} ${path} → ${outcome}`
}

/** The laptop's local time with its offset, e.g. "2026-09-30T15:45:00+05:30". */
export function localTimestamp(date = new Date()): string {
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  )
}

/** The build the UI was made from (vite.config.ts), to spot an old UI left in a browser. */
export const UI_BUILD: string = typeof __UI_BUILD__ === 'string' ? __UI_BUILD__ : 'unknown'

/** Everything the browser adds to feedback. */
export function clientInfo(now = new Date()): FeedbackClientInfo {
  let timezone = ''
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''
  } catch {
    // leave it empty
  }
  return {
    local_time: localTimestamp(now),
    timezone,
    language: navigator.language ?? '',
    user_agent: navigator.userAgent ?? '',
    screen: `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`,
    window: `${window.innerWidth}x${window.innerHeight}`,
    ui_build: UI_BUILD,
    errors: recentErrors(),
  }
}
