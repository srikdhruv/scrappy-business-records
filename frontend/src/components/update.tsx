/**
 * Updating from inside the app (ADR 0006): the "new version" banner, "See what's new", the
 * "Update now" question, and the screen shown while the app updates itself.
 *
 * `UpdateProvider` (in providers.tsx) owns the dialogs and the Updating screen, so the banner,
 * the ⚙ menu and About all open the same ones. The waiting logic is in lib/update.ts.
 */
import {
  CircleCheckIcon,
  DownloadIcon,
  LoaderCircleIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'

import { useStartUpdate, useUpdateInfo } from '@/api/queries'
import type { UpdateInfo } from '@/api/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { errorMessage } from '@/lib/errors'
import { findUnsavedInput } from '@/lib/unsaved'
import {
  alreadyTold,
  dismiss,
  isDismissed,
  isSettled,
  markSettled,
  markTold,
  page,
  watchUpdate,
  type UpdatePhase,
} from '@/lib/update'
import { cn } from '@/lib/utils'

const WAITING: UpdatePhase = { kind: 'waiting', slow: false }

/** "Updated to version X" is only worth saying for a while after it happened. */
const TELL_WITHIN_MS = 30 * 60_000

interface Updating {
  fromVersion: string
  toVersion: string
  startedAt: string | null
  phase: UpdatePhase
}

interface UpdateContextValue {
  info: UpdateInfo | undefined
  /** A newer version can be installed from here. */
  ready: boolean
  /** Open "Update to version X?". */
  askToUpdate: () => void
  /** Open "What's new in version X". */
  showWhatsNew: () => void
}

const UpdateContext = createContext<UpdateContextValue | null>(null)

// eslint-disable-next-line react-refresh/only-export-components
export function useUpdate(): UpdateContextValue {
  const value = useContext(UpdateContext)
  if (!value) throw new Error('useUpdate must be used inside <UpdateProvider>')
  return value
}

export function UpdateProvider({ children }: { children: ReactNode }) {
  const { data: info } = useUpdateInfo()
  const [dialog, setDialog] = useState<'confirm' | 'notes' | null>(null)
  const [updating, setUpdating] = useState<Updating | null>(null)
  const ready = Boolean(info?.update_available && info.can_update && info.latest)

  // An update started in another window of the app shows the same screen here, so this one
  // reloads onto the new version too.
  // Never for an update this window already gave up on (it may still say "running" for a
  // while: the server gives up on it after 30 minutes).
  const last = info?.last_attempt
  const running = last?.outcome === 'running' && !isSettled(last.started_at) ? last : null
  const shown: Updating | null =
    updating ??
    (running && info
      ? {
          fromVersion: info.current,
          toVersion: running.to_version,
          startedAt: running.started_at,
          phase: WAITING,
        }
      : null)

  // Follow an update to the end: reload on the new version, or say what went wrong.
  const watching = shown !== null && shown.phase.kind === 'waiting'
  const fromVersion = shown?.fromVersion
  const toVersion = shown?.toVersion ?? ''
  const startedAt = shown?.startedAt ?? null
  useEffect(() => {
    if (!watching || !fromVersion) return
    return watchUpdate({
      fromVersion,
      startedAt,
      onPhase: (phase) => {
        setUpdating((current) => ({
          ...(current ?? { fromVersion, toVersion, startedAt }),
          phase,
        }))
        if (phase.kind === 'done') page.reload()
        if ((phase.kind === 'failed' || phase.kind === 'timeout') && startedAt) {
          markSettled(startedAt) // said here: not again, and not "The last update didn't finish"
        }
      },
    })
  }, [watching, fromVersion, toVersion, startedAt])

  // Just updated (this page was reloaded onto the new version): say so, once.
  const told = useRef(false)
  useEffect(() => {
    const attempt = info?.last_attempt
    if (told.current || !info || !attempt || attempt.outcome !== 'succeeded') return
    if (attempt.to_version !== info.current || !attempt.finished_at) return
    if (Date.now() - new Date(attempt.finished_at).getTime() > TELL_WITHIN_MS) return
    told.current = true
    if (alreadyTold(attempt.started_at)) return
    markTold(attempt.started_at)
    toast.success(`Updated to version ${info.current}. Your records are just as you left them.`)
  }, [info])

  const value = useMemo<UpdateContextValue>(
    () => ({
      info,
      ready,
      askToUpdate: () => setDialog('confirm'),
      showWhatsNew: () => setDialog('notes'),
    }),
    [info, ready],
  )

  return (
    <UpdateContext.Provider value={value}>
      {children}
      {info?.latest && (
        <>
          <WhatsNewDialog
            info={info}
            open={dialog === 'notes'}
            onOpenChange={(open) => setDialog(open ? 'notes' : null)}
            onUpdate={() => setDialog('confirm')}
          />
          <ConfirmUpdateDialog
            info={info}
            open={dialog === 'confirm'}
            onOpenChange={(open) => setDialog(open ? 'confirm' : null)}
            onStarted={(started) => {
              setDialog(null)
              setUpdating({
                fromVersion: started.current,
                toVersion: started.last_attempt?.to_version ?? started.latest ?? '',
                startedAt: started.last_attempt?.started_at ?? null,
                phase: WAITING,
              })
            }}
          />
        </>
      )}
      {shown && (
        <UpdatingScreen
          updating={shown}
          logFile={info?.log_file ?? ''}
          onBack={() => page.reload()}
          onCheckAgain={() =>
            setUpdating((current) => (current ? { ...current, phase: WAITING } : current))
          }
        />
      )}
    </UpdateContext.Provider>
  )
}

// ---- the banner at the top of every page -------------------------------------------------------

export function UpdateBanner() {
  const { info, ready, askToUpdate, showWhatsNew } = useUpdate()
  const [hidden, setHidden] = useState(false)
  // The last update failed or was cut short (a restart, say), and this window hasn't said so
  // yet: say it once.
  const failedAt = info?.last_attempt?.outcome === 'failed' ? info.last_attempt.started_at : null
  const [notice, setNotice] = useState<{ id: string; show: boolean } | null>(null)
  if (failedAt && notice?.id !== failedAt) setNotice({ id: failedAt, show: !isSettled(failedAt) })
  useEffect(() => {
    if (notice?.show) markSettled(notice.id) // said once
  }, [notice])
  const close = () => setNotice((n) => (n ? { ...n, show: false } : n))
  if (notice?.show) {
    return (
      <section
        aria-label="The last update"
        className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-partial/30 bg-partial-soft px-4 py-3 print:hidden"
      >
        <TriangleAlertIcon className="size-5 shrink-0 text-partial" aria-hidden />
        <p className="min-w-0 flex-1 text-base">
          <strong>
            {info?.last_attempt?.records_restored
              ? 'The last update didn’t finish — your records were put back as they were before the update.'
              : 'The last update didn’t finish — your records are safe.'}
          </strong>{' '}
          <span className="text-foreground/80">
            You still have version {info?.current}, just as it was.
          </span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {ready && (
            <Button
              onClick={() => {
                close()
                askToUpdate()
              }}
            >
              Try again
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
            OK
          </Button>
        </div>
      </section>
    )
  }
  if (!ready || !info?.latest || hidden || isDismissed(info.latest)) return null
  const latest = info.latest
  return (
    <section
      aria-label="New version"
      className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border border-primary/30 bg-card px-4 py-3 shadow-soft print:hidden"
    >
      <SparklesIcon className="size-5 shrink-0 text-primary-strong" aria-hidden />
      <p className="min-w-0 flex-1 text-base">
        <strong>A new version ({latest}) is ready.</strong>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={showWhatsNew}>
          See what’s new
        </Button>
        <Button onClick={askToUpdate}>
          <DownloadIcon aria-hidden />
          Update now
        </Button>
        <Button
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => {
            dismiss(latest)
            setHidden(true)
          }}
        >
          Not now
        </Button>
      </div>
    </section>
  )
}

/** The small dot on the ⚙ Settings button while a new version is waiting (the button's name
 * says so too, for screen readers). */
export function UpdateDot({ className }: { className?: string }) {
  const { ready } = useUpdate()
  if (!ready) return null
  return (
    <span
      aria-hidden
      data-testid="update-dot"
      className={cn(
        'absolute size-2.5 rounded-full bg-primary ring-2 ring-sidebar print:hidden',
        className,
      )}
    />
  )
}

// ---- What's new --------------------------------------------------------------------------------

function WhatsNewDialog({
  info,
  open,
  onOpenChange,
  onUpdate,
}: {
  info: UpdateInfo
  open: boolean
  onOpenChange: (open: boolean) => void
  onUpdate: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>What’s new in version {info.latest}</DialogTitle>
          <DialogDescription>You have version {info.current}.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] overflow-y-auto rounded-lg bg-muted/50 px-4 py-3 text-base whitespace-pre-wrap">
          {info.notes || 'No notes for this version.'}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {info.can_update && (
            <Button onClick={onUpdate}>
              <DownloadIcon aria-hidden />
              Update now
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- "Update to version X?" --------------------------------------------------------------------

function ConfirmUpdateDialog({
  info,
  open,
  onOpenChange,
  onStarted,
}: {
  info: UpdateInfo
  open: boolean
  onOpenChange: (open: boolean) => void
  onStarted: (info: UpdateInfo) => void
}) {
  const start = useStartUpdate()
  const [unsaved, setUnsaved] = useState<{ here: boolean; elsewhere: boolean } | null>(null)
  // Blocks a second click before `isPending` has re-rendered the button as disabled.
  const clicked = useRef(false)

  useEffect(() => {
    if (!open) return
    clicked.current = false
    start.reset()
    let current = true
    void findUnsavedInput().then((found) => current && setUnsaved(found))
    return () => {
      current = false
      setUnsaved(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when it opens
  }, [open])

  const confirm = useCallback(() => {
    if (clicked.current || !info.latest) return
    clicked.current = true
    start.mutate(info.latest, {
      onSuccess: onStarted,
      onSettled: () => {
        clicked.current = false
      },
    })
  }, [info.latest, onStarted, start])

  const pending = start.isPending
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Update to version {info.latest}?</DialogTitle>
          <DialogDescription>
            Updating takes about a minute. Your records are kept and backed up first. The app will
            reopen by itself.
          </DialogDescription>
        </DialogHeader>
        {(unsaved?.here || unsaved?.elsewhere) && (
          <p
            role="alert"
            className="flex gap-2 rounded-lg border border-partial/30 bg-partial-soft px-3 py-2 text-base"
          >
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-partial" aria-hidden />
            <span>
              {unsaved.elsewhere
                ? 'Something you typed in another Scrappy Records window isn’t saved yet.'
                : 'Something you typed in a form isn’t saved yet.'}{' '}
              Save it first, or it will be lost when the app reopens.
            </span>
          </p>
        )}
        {start.isError && (
          <p role="alert" className="text-owed">
            {errorMessage(start.error)}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            size="lg"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Not now
          </Button>
          <Button size="lg" disabled={pending} onClick={confirm}>
            {pending ? 'Starting…' : 'Update now'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---- while it updates --------------------------------------------------------------------------

function UpdatingScreen({
  updating,
  logFile,
  onBack,
  onCheckAgain,
}: {
  updating: Updating
  logFile: string
  /** The app is running (the old version): back to it. */
  onBack: () => void
  /** The app isn't answering: look again (after she opened it from the Desktop, say). */
  onCheckAgain: () => void
}) {
  const { phase, fromVersion, toVersion } = updating
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [phase.kind])

  const failed = phase.kind === 'failed' || phase.kind === 'timeout'
  const appRunning = failed && phase.appRunning
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 px-5 print:hidden"
      data-testid="updating-screen"
    >
      <div
        role={failed ? 'alert' : 'status'}
        aria-live="polite"
        className="w-full max-w-lg rounded-2xl border bg-card p-6 shadow-soft sm:p-8"
      >
        {failed ? (
          <TriangleAlertIcon className="mb-4 size-8 text-owed" aria-hidden />
        ) : phase.kind === 'done' ? (
          <CircleCheckIcon className="mb-4 size-8 text-paid" aria-hidden />
        ) : (
          <LoaderCircleIcon className="mb-4 size-8 animate-spin text-primary-strong" aria-hidden />
        )}
        <h2 ref={heading} tabIndex={-1} className="text-xl font-extrabold outline-none">
          {phase.kind === 'failed'
            ? 'The update didn’t finish'
            : phase.kind === 'timeout'
              ? 'The update is taking too long'
              : phase.kind === 'done'
                ? `Version ${phase.version} is ready`
                : 'Updating… the app will reopen in a minute'}
        </h2>
        <div className="mt-3 space-y-3 text-base text-foreground/85">
          {phase.kind === 'waiting' && (
            <>
              <p>
                Installing version {toVersion}. Your records are kept, and a backup copy is saved
                first. Please leave this window open.
              </p>
              {phase.slow && (
                <p>
                  This is taking longer than usual, but it’s still working. A slow internet
                  connection can make it take a few minutes.
                </p>
              )}
            </>
          )}
          {phase.kind === 'done' && <p>Opening it now…</p>}
          {failed && (
            <>
              <p>
                {phase.kind === 'failed' && phase.detail
                  ? phase.detail
                  : `The update to version ${toVersion} didn’t finish.`}
              </p>
              <p>
                {phase.kind === 'failed' && phase.recordsRestored && (
                  <>Your records were put back as they were before the update. </>
                )}
                <strong>Your records are safe.</strong> If the new version didn’t go in, the old one
                ({fromVersion}) is still there, just as it was.
              </p>
              {!appRunning && (
                <p>
                  Double-click <strong>Scrappy Records</strong> on your Desktop to open it again (on
                  a Mac, open it from Applications).
                </p>
              )}
              {logFile && (
                <p className="text-sm text-muted-foreground">
                  If it keeps happening, send this file to whoever set up the app:{' '}
                  <span className="font-mono break-all">{logFile}</span>
                </p>
              )}
              {phase.kind === 'failed' && phase.technical && (
                <details className="text-sm text-muted-foreground">
                  <summary className="cursor-pointer">Technical details</summary>
                  <p className="mt-1 font-mono break-words">{phase.technical}</p>
                </details>
              )}
            </>
          )}
        </div>
        {failed && (
          <div className="mt-6 flex justify-end">
            <Button size="lg" onClick={appRunning ? onBack : onCheckAgain}>
              {appRunning ? 'Back to the app' : 'Check again'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
