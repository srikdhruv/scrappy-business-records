import {
  clearErrors,
  clientInfo,
  describeError,
  describeRequest,
  ERROR_CAPACITY,
  installErrorListeners,
  localTimestamp,
  recentErrors,
  recordError,
  RingBuffer,
} from './diagnostics'

afterEach(() => clearErrors())

describe('RingBuffer', () => {
  it('keeps the newest items, oldest first', () => {
    const ring = new RingBuffer<number>(3)
    for (let i = 1; i <= 5; i++) ring.push(i)
    expect(ring.toArray()).toEqual([3, 4, 5])
    expect(ring.size).toBe(3)
  })

  it('hands out a copy', () => {
    const ring = new RingBuffer<number>(2)
    ring.push(1)
    ring.toArray().push(99)
    expect(ring.toArray()).toEqual([1])
  })

  it('clears, and has room for at least one', () => {
    const ring = new RingBuffer<string>(0)
    ring.push('a')
    ring.push('b')
    expect(ring.toArray()).toEqual(['b'])
    ring.clear()
    expect(ring.size).toBe(0)
  })
})

describe('recent errors', () => {
  it('keeps the last 20, each cut to 1,000 characters', () => {
    for (let i = 0; i < 30; i++) recordError('error', `error ${i}`)
    recordError('api', 'x'.repeat(5000), new Date('2026-10-15T10:00:00Z'))
    const errors = recentErrors()
    expect(errors).toHaveLength(ERROR_CAPACITY)
    expect(errors[0]!.message).toBe('error 11')
    const last = errors.at(-1)!
    expect(last).toEqual({ at: '2026-10-15T10:00:00.000Z', kind: 'api', message: 'x'.repeat(1000) })
  })

  it('catches script errors and unhandled rejections', () => {
    const target = new EventTarget() as unknown as Window
    const stop = installErrorListeners(target)
    target.dispatchEvent(
      new ErrorEvent('error', { message: 'boom', filename: 'app.js', lineno: 3, colno: 7 }),
    )
    const rejection = new Event('unhandledrejection') as PromiseRejectionEvent
    Object.defineProperty(rejection, 'reason', { value: new TypeError('Failed to fetch') })
    target.dispatchEvent(rejection)
    stop()
    target.dispatchEvent(new ErrorEvent('error', { message: 'after stop' }))
    expect(recentErrors().map((e) => [e.kind, e.message])).toEqual([
      ['error', 'boom (app.js:3:7)'],
      ['rejection', 'TypeError: Failed to fetch'],
    ])
  })

  it('describes a request by path only (queries can hold names)', () => {
    const request = new Request('http://127.0.0.1:8765/api/students?q=Ananya', { method: 'GET' })
    expect(describeRequest(request, '500')).toBe('GET /api/students → 500')
  })

  it('describes anything thrown', () => {
    expect(describeError(new RangeError('too far'))).toBe('RangeError: too far')
    expect(describeError('plain')).toBe('plain')
    expect(describeError({ a: 1 })).toBe('{"a":1}')
    expect(describeError(undefined)).toBe('undefined')
  })
})

describe('clientInfo', () => {
  it('has the local time with its offset, the page size and the recent errors', () => {
    recordError('api', 'GET /api/dashboard → 500')
    const info = clientInfo(new Date(2026, 9, 15, 10, 5, 9))
    expect(info.local_time).toMatch(/^2026-10-15T10:05:09[+-]\d\d:\d\d$/)
    expect(info.window).toMatch(/^\d+x\d+$/)
    expect(info.user_agent).toBeTruthy()
    expect(info.ui_build).toBeTruthy()
    expect(info.errors).toEqual([expect.objectContaining({ message: 'GET /api/dashboard → 500' })])
  })

  it('writes offsets like +05:30', () => {
    const date = new Date(2026, 0, 2, 3, 4, 5)
    const offset = -date.getTimezoneOffset()
    const sign = offset >= 0 ? '+' : '-'
    const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')
    const mm = String(Math.abs(offset) % 60).padStart(2, '0')
    expect(localTimestamp(date)).toBe(`2026-01-02T03:04:05${sign}${hh}:${mm}`)
  })
})
