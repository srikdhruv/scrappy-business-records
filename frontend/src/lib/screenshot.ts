/**
 * A picture of the page for feedback, taken in the browser with `html-to-image` (bundled, no
 * CDN). It draws the app's own `#root` element, so the feedback dialog (rendered outside it, in
 * a portal) is never in the picture: the owner sees exactly the screen she was on.
 *
 * The picture is a JPEG, made smaller until it is at most `SCREENSHOT_MAX_BYTES` (the server's
 * limit, `app/schemas.py`).
 */
import { toCanvas } from 'html-to-image'

export const SCREENSHOT_MAX_BYTES = 1_400_000
const MAX_WIDTH = 1600
const MAX_HEIGHT = 2400
const QUALITIES = [0.85, 0.7, 0.55, 0.4]

export interface Screenshot {
  /** `data:image/jpeg;base64,...` */
  dataUrl: string
  bytes: number
  width: number
  height: number
}

/** The decoded size of a base64 data URL. */
export function dataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

/** The part of a tall page to keep: all of it, or `maxHeight` around where the owner is. */
export function cropWindow(
  pageHeight: number,
  scrollY: number,
  maxHeight = MAX_HEIGHT,
): { top: number; height: number } {
  if (pageHeight <= maxHeight) return { top: 0, height: pageHeight }
  const top = Math.min(Math.max(0, scrollY - 200), pageHeight - maxHeight)
  return { top, height: maxHeight }
}

function resized(source: HTMLCanvasElement, top: number, height: number, scale: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(source, 0, top, source.width, height, 0, 0, canvas.width, canvas.height)
  return canvas
}

/** Encode as JPEG, lowering the quality and then the size until it fits `maxBytes`. */
export function compress(
  source: HTMLCanvasElement,
  top = 0,
  height = source.height,
  maxBytes = SCREENSHOT_MAX_BYTES,
): Screenshot | null {
  let scale = Math.min(1, MAX_WIDTH / Math.max(1, source.width))
  for (let round = 0; round < 4; round++) {
    const canvas = resized(source, top, height, scale)
    if (!canvas) return null
    for (const quality of QUALITIES) {
      const dataUrl = canvas.toDataURL('image/jpeg', quality)
      if (!dataUrl.startsWith('data:image/jpeg')) return null
      const bytes = dataUrlBytes(dataUrl)
      if (bytes <= maxBytes) return { dataUrl, bytes, width: canvas.width, height: canvas.height }
    }
    scale /= 2
  }
  return null
}

/** Take the picture, or null if the browser couldn't (the feedback is sent without it). */
export async function captureScreen(
  node: HTMLElement | null = document.getElementById('root'),
): Promise<Screenshot | null> {
  if (!node) return null
  try {
    const background = getComputedStyle(document.body).backgroundColor || '#ffffff'
    const full = await toCanvas(node, {
      pixelRatio: 1,
      backgroundColor: background,
      // Anything marked `data-feedback-hide` stays out of the picture.
      filter: (el) => !(el instanceof HTMLElement && el.dataset.feedbackHide !== undefined),
    })
    const { top, height } = cropWindow(full.height, window.scrollY)
    return compress(full, top, height)
  } catch {
    return null
  }
}
