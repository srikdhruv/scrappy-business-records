import {
  alreadyTold,
  dismiss,
  isSettled,
  markSettled,
  GIVE_UP_MS,
  isDismissed,
  markTold,
  nextPhase,
  POLL_MS,
  SLOW_MS,
  watchUpdate,
  type AttemptSeen,
  type UpdatePhase,
} from './update'

const UPDATE = { fromVersion: '0.2.0', startedAt: '2026-09-30T10:00:00+00:00' }
const failed = (startedAt = UPDATE.startedAt): AttemptSeen => ({
  outcome: 'failed',
  started_at: startedAt,
  detail: 'The update to version 0.3.0 didn’t finish, so you still have version 0.2.0.',
})

describe('nextPhase', () => {
  it('is done as soon as another version answers', () => {
    expect(nextPhase(UPDATE, { elapsedMs: 5_000, version: '0.3.0', attempt: null })).toEqual({
      kind: 'done',
      version: '0.3.0',
    })
  })

  it('keeps waiting while the app is down or still the old version', () => {
    for (const version of [null, '0.2.0']) {
      expect(nextPhase(UPDATE, { elapsedMs: 5_000, version, attempt: null })).toEqual({
        kind: 'waiting',
        slow: false,
      })
    }
    const running = { ...failed(), outcome: 'running' }
    expect(nextPhase(UPDATE, { elapsedMs: 1, version: '0.2.0', attempt: running }).kind).toBe(
      'waiting',
    )
  })

  it('says it failed when the old version is back and says so', () => {
    expect(nextPhase(UPDATE, { elapsedMs: 60_000, version: '0.2.0', attempt: failed() })).toEqual({
      kind: 'failed',
      detail: failed().detail,
      technical: '',
      appRunning: true,
    })
  })

  it('ignores an older failed attempt', () => {
    const old = failed('2026-09-01T10:00:00+00:00')
    expect(nextPhase(UPDATE, { elapsedMs: 1, version: '0.2.0', attempt: old }).kind).toBe('waiting')
  })

  it('is slow after 3 minutes and gives up after 10', () => {
    expect(nextPhase(UPDATE, { elapsedMs: SLOW_MS, version: null, attempt: null })).toEqual({
      kind: 'waiting',
      slow: true,
    })
    expect(nextPhase(UPDATE, { elapsedMs: GIVE_UP_MS, version: null, attempt: null })).toEqual({
      kind: 'timeout',
      appRunning: false,
    })
    expect(nextPhase(UPDATE, { elapsedMs: GIVE_UP_MS, version: '0.2.0', attempt: null })).toEqual({
      kind: 'timeout',
      appRunning: true,
    })
  })
})

describe('watchUpdate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function watch(versions: (string | null)[], attempt: AttemptSeen | null = null) {
    const phases: UpdatePhase[] = []
    const fetchVersion = vi.fn(async () => (versions.length > 1 ? versions.shift()! : versions[0]!))
    const fetchAttempt = vi.fn(async () => attempt)
    const stop = watchUpdate({
      ...UPDATE,
      onPhase: (phase) => phases.push(phase),
      fetchVersion,
      fetchAttempt,
      now: () => Date.now(),
    })
    return { phases, stop, fetchVersion, fetchAttempt }
  }

  it('polls every 2 s through the restart until the new version answers', async () => {
    const { phases, fetchAttempt } = watch(['0.2.0', null, null, '0.3.0'])
    await vi.advanceTimersByTimeAsync(POLL_MS * 4)
    expect(phases.map((p) => p.kind)).toEqual(['waiting', 'waiting', 'waiting', 'done'])
    expect(phases.at(-1)).toEqual({ kind: 'done', version: '0.3.0' })
    // The attempt is only asked while the old version answers.
    expect(fetchAttempt).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(phases).toHaveLength(4) // stopped once done
  })

  it('stops at a failure', async () => {
    const { phases } = watch([null, '0.2.0'], failed())
    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(phases.map((p) => p.kind)).toEqual(['waiting', 'failed'])
  })

  it('gives up after 10 minutes', async () => {
    const { phases } = watch([null])
    await vi.advanceTimersByTimeAsync(GIVE_UP_MS + POLL_MS)
    expect(phases.at(-1)).toEqual({ kind: 'timeout', appRunning: false })
    expect(phases.some((p) => p.kind === 'waiting' && p.slow)).toBe(true)
  })

  it('can be stopped', async () => {
    const { phases, stop, fetchVersion } = watch([null])
    await vi.advanceTimersByTimeAsync(POLL_MS)
    stop()
    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(phases).toHaveLength(1)
    expect(fetchVersion).toHaveBeenCalledTimes(1)
  })
})

describe('Not now, and saying "Updated" once', () => {
  beforeEach(() => localStorage.clear())

  it('hides the banner for that version only', () => {
    expect(isDismissed('0.3.0')).toBe(false)
    dismiss('0.3.0')
    expect(isDismissed('0.3.0')).toBe(true)
    expect(isDismissed('0.4.0')).toBe(false)
  })

  it('remembers which update it told about', () => {
    expect(alreadyTold('a')).toBe(false)
    markTold('a')
    expect(alreadyTold('a')).toBe(true)
    expect(alreadyTold('b')).toBe(false)
  })
})

describe('settled attempts', () => {
  beforeEach(() => localStorage.clear())

  it('remembers the attempts this window finished with (the last 10)', () => {
    expect(isSettled('a')).toBe(false)
    markSettled('a')
    markSettled('a')
    expect(isSettled('a')).toBe(true)
    for (let i = 0; i < 12; i++) markSettled(`x${i}`)
    expect(isSettled('a')).toBe(false)
    expect(isSettled('x11')).toBe(true)
  })

  it('a broken value is ignored', () => {
    localStorage.setItem('scrappy-update-settled', '{nope')
    expect(isSettled('a')).toBe(false)
    markSettled('a')
  })
})
