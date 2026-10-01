/** Rules the feedback dialog follows (components/feedback-dialog.tsx). */
import type { FeedbackRead } from '@/api/types'

/** The longest message (the server's limit too, `app/schemas.py`). */
export const MESSAGE_LIMIT = 5000
/** How long the dialog waits for "Sent" before saying "Saved, it'll go by itself". */
export const WAIT_FOR_SENT_MS = 15_000

/** `saved`: it goes by itself later. `held`: this copy can't send it (no relay set). */
/** Said in the dialog before she types, when this copy can't send feedback. */
export const NOT_SENDING_NOTE =
  'Sending feedback isn’t switched on in this version yet. What you write is saved on this laptop, but it can’t be sent yet — please also tell the developer another way.'

export type Outcome = 'sending' | 'sent' | 'saved' | 'held' | 'failed'

/** What to tell the owner, from the saved feedback's status and how long we've waited. */
export function feedbackOutcome(saved: FeedbackRead | undefined, waitedMs: number): Outcome {
  if (!saved) return 'sending'
  if (saved.status === 'sent') return 'sent'
  if (saved.status === 'failed') return 'failed'
  // This version doesn't send feedback at all: say so plainly.
  if (!saved.sending) return 'held'
  // Already tried once (offline), or taking too long: it goes by itself later.
  if (saved.attempts > 0 || waitedMs >= WAIT_FOR_SENT_MS) return 'saved'
  return 'sending'
}
