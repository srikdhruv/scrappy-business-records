/**
 * "Is anything typed in and not saved yet?" Asked before an update, which reopens the app and
 * reloads every open Scrappy Records window.
 *
 * Forms mark themselves with `<TrackUnsaved>` (components/track-unsaved.tsx): typing anything
 * in them counts until they close. Other windows (tabs) of the app are asked too, through a
 * BroadcastChannel; each answers for itself.
 */

import { useCallback, useEffect, useId } from 'react'

const CHANNEL = 'scrappy-unsaved'
const unsaved = new Set<string>()
let channel: BroadcastChannel | null | undefined

interface Ask {
  type: 'ask'
  id: string
}
interface Answer {
  type: 'answer'
  id: string
  unsaved: boolean
}

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel
  if (typeof BroadcastChannel === 'undefined') return (channel = null)
  try {
    channel = new BroadcastChannel(CHANNEL)
  } catch {
    return (channel = null)
  }
  // In Node (tests), don't keep the process alive for it.
  ;(channel as unknown as { unref?: () => void }).unref?.()
  channel.addEventListener('message', (event: MessageEvent<Ask | Answer>) => {
    const message = event.data
    if (message?.type === 'ask' && unsaved.size > 0) {
      channel?.postMessage({ type: 'answer', id: message.id, unsaved: true } satisfies Answer)
    }
  })
  return channel
}

/** Mark (or clear) one form as having unsaved input. */
export function setUnsaved(key: string, value: boolean) {
  if (value) unsaved.add(key)
  else unsaved.delete(key)
  // Start listening, so other windows asking get an answer from this one.
  if (value) getChannel()
}

/** Something typed in this window and not saved? */
export function hasUnsavedHere(): boolean {
  return unsaved.size > 0
}

/** Ask this window and every other open window of the app. Answers within `waitMs`. */
export async function findUnsavedInput(
  waitMs = 300,
): Promise<{ here: boolean; elsewhere: boolean }> {
  const here = hasUnsavedHere()
  const ch = getChannel()
  if (!ch) return { here, elsewhere: false }
  const id = Math.random().toString(36).slice(2)
  return new Promise((resolve) => {
    let elsewhere = false
    const listener = (event: MessageEvent<Ask | Answer>) => {
      if (event.data?.type === 'answer' && event.data.id === id && event.data.unsaved) {
        elsewhere = true
      }
    }
    ch.addEventListener('message', listener)
    ch.postMessage({ type: 'ask', id } satisfies Ask)
    setTimeout(() => {
      ch.removeEventListener('message', listener)
      resolve({ here, elsewhere })
    }, waitMs)
  })
}

/**
 * For a form in a dialog that stays mounted: counts from the first keystroke until `open` is
 * false. Put the returned handler on the form's `onInputCapture`.
 */
export function useTrackUnsaved(open = true) {
  const key = useId()
  useEffect(() => {
    if (!open) setUnsaved(key, false)
    return () => setUnsaved(key, false)
  }, [key, open])
  return useCallback(() => setUnsaved(key, true), [key])
}

/** Tests only: forget every mark. */
export function resetUnsaved() {
  unsaved.clear()
}
