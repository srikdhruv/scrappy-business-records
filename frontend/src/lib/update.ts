/**
 * What the page does while the app updates itself (ADR 0006).
 *
 * After Update now, the server starts the installer, which stops the server, backs up, puts the
 * new version in place and opens it again. Meanwhile this page asks `/api/health` every 2 s:
 *
 * - it answers with a **different version** → the new one is running: reload the page (the new
 *   version's UI loads, since index.html is never cached);
 * - it answers with the **same version** and `/api/update` says this attempt **failed** → say so
 *   (the installer has put everything back, and reopened the old version if it had closed it);
 * - **no answer** → the app is being replaced: keep waiting;
 * - after 3 minutes, say it's taking longer than usual; after 10, give up and say what to do.
 *
 * The health requests carry `?waiting_for_update=true`, so the new version's launcher knows this
 * page will reload itself and doesn't open a second browser tab. The new server must keep
 * accepting that, and `{app, version}` in `/api/health`: this page is the OLD version's.
 *
 * Plain `fetch`, not the typed client: while the server is down every request fails, and those
 * failures shouldn't fill the list of recent errors that feedback sends.
 */

export const POLL_MS = 2_000
export const SLOW_MS = 3 * 60_000
export const GIVE_UP_MS = 10 * 60_000
const REQUEST_TIMEOUT_MS = 5_000

export type UpdatePhase =
  | { kind: 'waiting'; slow: boolean }
  | { kind: 'done'; version: string }
  | { kind: 'failed'; detail: string | null; technical: string; appRunning: boolean }
  | { kind: 'timeout'; appRunning: boolean }

export interface AttemptSeen {
  outcome: string
  started_at: string
  detail: string
  technical?: string
}

export interface Observation {
  elapsedMs: number
  /** The version `/api/health` answered with, or null if it didn't answer. */
  version: string | null
  /** The last attempt, from `/api/update` (only asked while the old version answers). */
  attempt: AttemptSeen | null
}

/** One step of the wait: what the page should show after this observation. */
export function nextPhase(
  update: { fromVersion: string; startedAt: string | null },
  seen: Observation,
): UpdatePhase {
  if (seen.version !== null && seen.version !== update.fromVersion) {
    return { kind: 'done', version: seen.version }
  }
  if (
    seen.version !== null &&
    seen.attempt?.outcome === 'failed' &&
    (update.startedAt === null || seen.attempt.started_at === update.startedAt)
  ) {
    return {
      kind: 'failed',
      detail: seen.attempt.detail || null,
      technical: seen.attempt.technical ?? '',
      appRunning: true,
    }
  }
  if (seen.elapsedMs >= GIVE_UP_MS) return { kind: 'timeout', appRunning: seen.version !== null }
  return { kind: 'waiting', slow: seen.elapsedMs >= SLOW_MS }
}

/** The app's own address (an absolute one: Node, in tests, needs it). */
function origin(): string {
  return globalThis.location?.origin ?? ''
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await globalThis.fetch(url, { cache: 'no-store', signal: controller.signal })
    return response.ok ? await response.json() : null
  } catch {
    return null // the server is down (being replaced): that's expected
  } finally {
    clearTimeout(timer)
  }
}

/** The running version, or null if the app isn't answering (as ours). */
export async function fetchVersion(): Promise<string | null> {
  const body = (await getJson(`${origin()}/api/health?waiting_for_update=true`)) as {
    app?: unknown
    version?: unknown
  } | null
  return body?.app === 'scrappy-records' && typeof body.version === 'string' ? body.version : null
}

/** The last update attempt the running server knows about. */
export async function fetchAttempt(): Promise<AttemptSeen | null> {
  const body = (await getJson(`${origin()}/api/update`)) as {
    last_attempt?: AttemptSeen | null
  } | null
  return body?.last_attempt ?? null
}

export interface WatchOptions {
  fromVersion: string
  startedAt: string | null
  onPhase: (phase: UpdatePhase) => void
  fetchVersion?: () => Promise<string | null>
  fetchAttempt?: () => Promise<AttemptSeen | null>
  now?: () => number
}

/** Poll until the update is done, failed or given up on. Returns a function that stops it. */
export function watchUpdate({
  fromVersion,
  startedAt,
  onPhase,
  fetchVersion: getVersion = fetchVersion,
  fetchAttempt: getAttempt = fetchAttempt,
  now = Date.now,
}: WatchOptions): () => void {
  const started = now()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = async () => {
    if (stopped) return
    const version = await getVersion()
    const attempt = version !== null && version === fromVersion ? await getAttempt() : null
    if (stopped) return
    const phase = nextPhase(
      { fromVersion, startedAt },
      { elapsedMs: now() - started, version, attempt },
    )
    onPhase(phase)
    if (phase.kind === 'waiting') timer = setTimeout(() => void tick(), POLL_MS)
  }
  timer = setTimeout(() => void tick(), POLL_MS)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/** Reload the page (the new version's UI). A function so tests can replace it. */
export const page = {
  reload: () => window.location.reload(),
}

// ---- "Not now" on the banner: hidden until a newer version comes out ----------------------------

const DISMISSED_KEY = 'scrappy-update-dismissed'
const SETTLED_KEY = 'scrappy-update-settled'
const TOLD_KEY = 'scrappy-update-told'

export function isDismissed(version: string): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) === version
  } catch {
    return false
  }
}

export function dismiss(version: string) {
  try {
    localStorage.setItem(DISMISSED_KEY, version)
  } catch {
    // private window: it just shows again next time
  }
}

/** "Updated to version X" is said once per update (the attempt's start time). */
export function alreadyTold(startedAt: string): boolean {
  try {
    return localStorage.getItem(TOLD_KEY) === startedAt
  } catch {
    return true
  }
}

export function markTold(startedAt: string) {
  try {
    localStorage.setItem(TOLD_KEY, startedAt)
  } catch {
    // nothing to do
  }
}

// ---- Attempts this window has already finished with ---------------------------------------------

/**
 * An update (by its start time) this window gave up waiting for, or has already told the owner
 * didn't finish. The Updating screen never comes back for it, and "The last update didn't
 * finish" is said once.
 */
export function isSettled(startedAt: string): boolean {
  try {
    return (JSON.parse(localStorage.getItem(SETTLED_KEY) ?? '[]') as string[]).includes(startedAt)
  } catch {
    return false
  }
}

export function markSettled(startedAt: string) {
  try {
    const list = JSON.parse(localStorage.getItem(SETTLED_KEY) ?? '[]') as string[]
    if (!list.includes(startedAt)) {
      localStorage.setItem(SETTLED_KEY, JSON.stringify([...list, startedAt].slice(-10)))
    }
  } catch {
    // private window: at worst it's said again
  }
}
