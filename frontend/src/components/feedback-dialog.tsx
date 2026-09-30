/**
 * Settings → Send feedback. The owner picks Problem / Idea / Question, writes a message, and
 * (unless she unticks it) a picture of the screen she was on goes with it. The server saves it
 * on the laptop first and sends it to the developer's private feedback inbox in the background,
 * so the dialog says "Sent ✓" when that happens within a few seconds, or "Saved" otherwise
 * (offline: it goes later by itself). See docs/feature-guide.md, "Sending feedback".
 */
import {
  CheckCircle2Icon,
  CircleHelpIcon,
  ImageOffIcon,
  LightbulbIcon,
  LoaderCircleIcon,
  MessageSquareWarningIcon,
  SaveIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { useLocation } from 'react-router'

import { useAbout, useFeedbackStatus, useSendFeedback } from '@/api/queries'
import type { FeedbackCategory } from '@/api/types'
import { TrackUnsaved } from '@/components/track-unsaved'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { clientInfo, recentErrors } from '@/lib/diagnostics'
import { errorMessage } from '@/lib/errors'
import { feedbackOutcome, MESSAGE_LIMIT, NOT_SENDING_NOTE, type Outcome } from '@/lib/feedback'
import { CAPTURE_TIMEOUT_MS, captureScreen, type Screenshot } from '@/lib/screenshot'
import { cn } from '@/lib/utils'

const CATEGORIES: { value: FeedbackCategory; label: string; icon: LucideIcon; hint: string }[] = [
  {
    value: 'problem',
    label: 'Problem',
    icon: MessageSquareWarningIcon,
    hint: 'What happened, and what did you expect instead?',
  },
  {
    value: 'idea',
    label: 'Idea',
    icon: LightbulbIcon,
    hint: 'What would make Scrappy Records better for you?',
  },
  {
    value: 'question',
    label: 'Question',
    icon: CircleHelpIcon,
    hint: 'What would you like to know?',
  },
]

function newId(): string | undefined {
  // Secure contexts only (127.0.0.1 is one); the server makes an id otherwise.
  return globalThis.crypto?.randomUUID?.()
}

type Shot = { state: 'taking' } | { state: 'ready'; shot: Screenshot } | { state: 'none' }

export function FeedbackDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A fresh form (and picture) each time it opens. */}
      {open && (
        <TrackUnsaved>
          <FeedbackForm onClose={() => onOpenChange(false)} />
        </TrackUnsaved>
      )}
    </Dialog>
  )
}

function FeedbackForm({ onClose }: { onClose: () => void }) {
  const location = useLocation()
  // The page only: a query (a search, say) could hold a student's name.
  const route = location.pathname
  const [id] = useState(newId)
  const [category, setCategory] = useState<FeedbackCategory>('problem')
  const [message, setMessage] = useState('')
  const [includeShot, setIncludeShot] = useState(true)
  const [shot, setShot] = useState<Shot>({ state: 'taking' })
  const [showMissing, setShowMissing] = useState(false)
  const [enlarged, setEnlarged] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState(0)
  const [now, setNow] = useState(0)
  const send = useSendFeedback()
  const about = useAbout()
  const messageId = useId()
  const shotId = useId()
  const textRef = useRef<HTMLTextAreaElement>(null)
  const capture = useRef<Promise<Screenshot | null> | null>(null)
  const [waitingForPicture, setWaitingForPicture] = useState(false)

  // The picture is taken as the dialog opens, of the page behind it (not the dialog). It can
  // take a second or two on a big page; Send waits for it if needed.
  useEffect(() => {
    let cancelled = false
    capture.current ??= captureScreen({ timeoutMs: CAPTURE_TIMEOUT_MS })
    void capture.current.then((result) => {
      if (!cancelled) setShot(result ? { state: 'ready', shot: result } : { state: 'none' })
    })
    return () => {
      cancelled = true
    }
  }, [])

  const status = useFeedbackStatus(savedId, savedId !== null)
  const outcome = savedId ? feedbackOutcome(status.data, now - savedAt) : null
  const waiting = outcome === 'sending'

  // Tick while waiting, so "taking too long" turns into "Saved".
  useEffect(() => {
    if (!waiting) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [waiting])

  const trimmed = message.trim()
  const errors = recentErrors().length
  const hint = CATEGORIES.find((c) => c.value === category)?.hint

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!trimmed) {
      setShowMissing(true)
      textRef.current?.focus()
      return
    }
    let picture: string | null = null
    if (includeShot && shot.state === 'ready') picture = shot.shot.dataUrl
    else if (includeShot && shot.state === 'taking' && capture.current) {
      setWaitingForPicture(true)
      picture = (await capture.current)?.dataUrl ?? null
      setWaitingForPicture(false)
    }
    send.mutate(
      { id, category, message: trimmed, route, client: clientInfo(), screenshot: picture },
      {
        onSuccess: (saved) => {
          const start = Date.now()
          setSavedAt(start)
          setNow(start)
          setSavedId(saved.id)
        },
      },
    )
  }

  if (outcome) {
    return (
      <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
        </DialogHeader>
        <FeedbackOutcome outcome={outcome} />
        <DialogFooter>
          <Button onClick={onClose} autoFocus>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    )
  }

  return (
    <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
      <form onSubmit={(e) => void submit(e)} className="grid gap-5" noValidate>
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            Tell the developer about a problem, an idea or a question.
          </DialogDescription>
        </DialogHeader>

        {about.data && !about.data.feedback_sending && (
          <p
            role="note"
            className="flex items-start gap-2 rounded-lg border border-partial/40 bg-partial-soft px-3 py-2 text-sm"
          >
            <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-partial" aria-hidden />
            {NOT_SENDING_NOTE}
          </p>
        )}

        <fieldset className="grid gap-2">
          <legend className="mb-2 text-[0.9375rem] leading-none font-semibold">Type</legend>
          <ToggleGroup
            type="single"
            value={category}
            onValueChange={(v) => v && setCategory(v as FeedbackCategory)}
            spacing={2}
            className="grid w-full grid-cols-3"
          >
            {CATEGORIES.map(({ value, label, icon: Icon }) => (
              <ToggleGroupItem
                key={value}
                value={value}
                variant="outline"
                aria-label={label}
                className={cn(
                  'h-11 w-full bg-card text-base',
                  'data-[state=on]:border-primary data-[state=on]:bg-primary/25 data-[state=on]:text-foreground',
                )}
              >
                <Icon className="size-5" aria-hidden />
                {label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </fieldset>

        <div className="grid gap-2">
          <Label htmlFor={messageId}>Message</Label>
          <Textarea
            ref={textRef}
            id={messageId}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value)
              if (e.target.value.trim()) setShowMissing(false)
            }}
            placeholder={hint}
            maxLength={MESSAGE_LIMIT}
            rows={5}
            className="max-h-64 min-h-28"
            aria-invalid={showMissing || undefined}
            aria-describedby={showMissing ? `${messageId}-error` : undefined}
            autoFocus
          />
          {showMissing && (
            <p id={`${messageId}-error`} className="text-sm font-semibold text-owed">
              Please write a message.
            </p>
          )}
        </div>

        <div className="grid gap-3 rounded-xl border bg-muted/40 p-3">
          <div className="flex items-start gap-3">
            <ScreenPreview
              shot={shot}
              dimmed={!includeShot}
              enlarged={enlarged}
              onToggle={() => setEnlarged((e) => !e)}
            />
            <div className="grid min-w-0 gap-1.5">
              <label htmlFor={shotId} className="flex items-center gap-2 font-semibold">
                <input
                  id={shotId}
                  type="checkbox"
                  className="size-4 accent-current"
                  checked={includeShot && shot.state !== 'none'}
                  disabled={shot.state === 'none'}
                  onChange={(e) => setIncludeShot(e.target.checked)}
                />
                Include a picture of this screen
              </label>
              {shot.state === 'none' ? (
                <p className="text-sm text-muted-foreground">
                  The picture couldn’t be taken, so the message goes without it.
                </p>
              ) : shot.state === 'taking' ? (
                <p className="text-sm text-muted-foreground">Taking the picture…</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  The picture may show student names and amounts. It goes only to the developer’s
                  private feedback inbox. Click it to see it bigger.
                </p>
              )}
            </div>
          </div>
          {enlarged && shot.state === 'ready' && (
            <button
              type="button"
              onClick={() => setEnlarged(false)}
              className="overflow-hidden rounded-md border bg-card outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label="Make the picture smaller"
            >
              <img
                src={shot.shot.dataUrl}
                alt="The picture of this screen, bigger"
                className={cn('w-full', !includeShot && 'opacity-40')}
              />
            </button>
          )}
        </div>

        <details className="group rounded-xl border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-semibold">What gets sent</summary>
          <ul className="mt-2 grid list-disc gap-1 pl-5 text-muted-foreground">
            <li>Your message and its type.</li>
            <li>The picture of this screen, if the box is ticked.</li>
            <li>The date and time.</li>
            <li>
              The app’s version and build
              {about.data
                ? ` (${about.data.version}, build ${about.data.build_id.slice(0, 7)})`
                : ''}
              .
            </li>
            <li>
              The page you’re on (<span className="font-mono">{route}</span>), without what you
              searched for.
            </li>
            <li>
              The last problems the app noticed ({errors === 0 ? 'none so far' : errors}), and its
              last warnings and errors from the log file, with names and values taken out. For an
              error in the app itself, only what kind it was and where it happened, never its
              message.
            </li>
            <li>Your computer’s system, browser and screen size.</li>
            <li>A random number for this copy of the app. It doesn’t say who you are.</li>
            <li>
              <strong className="text-foreground">Never</strong> your records file, backups or
              downloads.
            </li>
          </ul>
          <p className="mt-2 text-muted-foreground">
            {about.data && !about.data.feedback_sending
              ? 'It’s saved on this laptop. This version can’t send it yet.'
              : 'It’s saved on this laptop first, and sent when the internet is on.'}
          </p>
        </details>

        {send.isError && (
          <p role="alert" className="rounded-lg bg-owed-soft px-3 py-2 text-sm text-owed">
            {errorMessage(send.error, 'The feedback couldn’t be saved. Please try again.')}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={send.isPending || waitingForPicture}>
            {send.isPending || waitingForPicture ? (
              <LoaderCircleIcon className="animate-spin" aria-hidden />
            ) : null}
            Send
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}

function ScreenPreview({
  shot,
  dimmed,
  enlarged,
  onToggle,
}: {
  shot: Shot
  dimmed: boolean
  enlarged: boolean
  onToggle: () => void
}) {
  const frame =
    'flex h-28 w-44 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-card'
  if (shot.state === 'taking') {
    return (
      <div className={frame} aria-label="Taking a picture of the screen">
        <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" aria-hidden />
      </div>
    )
  }
  if (shot.state === 'none') {
    return (
      <div className={frame}>
        <ImageOffIcon className="size-5 text-muted-foreground" aria-hidden />
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={enlarged}
      aria-label={enlarged ? 'Make the picture smaller' : 'See the picture bigger'}
      className={cn(
        frame,
        'cursor-zoom-in outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        enlarged && 'cursor-zoom-out',
        dimmed && 'opacity-40',
      )}
    >
      <img
        src={shot.shot.dataUrl}
        alt="Picture of this screen"
        className="h-full w-full object-cover object-top"
      />
    </button>
  )
}

function FeedbackOutcome({ outcome }: { outcome: Outcome }) {
  if (outcome === 'sending') {
    return (
      <p className="flex items-center gap-3 text-base" role="status">
        <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" aria-hidden />
        Sending…
      </p>
    )
  }
  if (outcome === 'sent') {
    return (
      <p className="flex items-start gap-3 text-base" role="status">
        <CheckCircle2Icon className="mt-0.5 size-5 shrink-0 text-paid" aria-hidden />
        <span>
          <strong>Sent ✓</strong> Thank you! The developer has it.
        </span>
      </p>
    )
  }
  if (outcome === 'failed') {
    return (
      <p className="flex items-start gap-3 text-base" role="status">
        <SaveIcon className="mt-0.5 size-5 shrink-0 text-partial" aria-hidden />
        <span>
          <strong>Saved on this laptop,</strong> but the feedback inbox didn’t accept it. Please
          tell the developer another way.
        </span>
      </p>
    )
  }
  if (outcome === 'held') {
    return (
      <p className="flex items-start gap-3 text-base" role="status">
        <SaveIcon className="mt-0.5 size-5 shrink-0 text-partial" aria-hidden />
        <span>
          <strong>Saved on this laptop.</strong> It can’t be sent yet — please also tell the
          developer another way.
        </span>
      </p>
    )
  }
  return (
    <p className="flex items-start gap-3 text-base" role="status">
      <SaveIcon className="mt-0.5 size-5 shrink-0 text-primary-strong" aria-hidden />
      <span>
        <strong>Saved</strong> — it’ll be sent automatically when you’re online.
      </span>
    </p>
  )
}
