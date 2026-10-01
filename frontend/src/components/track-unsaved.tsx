/**
 * Let the app know when something has been typed into a form and not saved (asked before an
 * update reloads the app; see lib/unsaved.ts). It counts from the first keystroke until the form
 * closes.
 *
 * - `<TrackUnsaved>` around a form that unmounts when it closes. React events bubble through
 *   portals, so it can wrap a dialog's content.
 * - `useTrackUnsaved(open)` (lib/unsaved.ts) for a dialog that stays mounted: put the returned
 *   handler on the form's `onInputCapture`.
 */
import type { ReactNode } from 'react'

import { useTrackUnsaved } from '@/lib/unsaved'

export function TrackUnsaved({ children }: { children: ReactNode }) {
  const onInput = useTrackUnsaved()
  return (
    <div className="contents" onInputCapture={onInput}>
      {children}
    </div>
  )
}
