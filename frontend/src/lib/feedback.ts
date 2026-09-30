/** Rules the feedback dialog follows (components/feedback-dialog.tsx). */
import type { FeedbackRead } from '@/api/types'

/** The longest message (the server's limit too, `app/schemas.py`). */
export const MESSAGE_LIMIT = 5000
/** How long the dialog waits for "Sent" before saying "Saved, it'll go by itself". */
export const WAIT_FOR_SENT_MS = 15_000

export type Outcome = 'sending' | 'sent' | 'saved' | 'failed'

/** What to tell the owner, from the saved feedback's status and how long we've waited. */
export function feedbackOutcome(saved: FeedbackRead | undefined, waitedMs: number): Outcome {
  if (!saved) return 'sending'
  if (saved.status === 'sent') return 'sent'
  if (saved.status === 'failed') return 'failed'
  // Not sending in this version, already tried once (offline), or taking too long.
  if (!saved.sending || saved.attempts > 0 || waitedMs >= WAIT_FOR_SENT_MS) return 'saved'
  return 'sending'
}
