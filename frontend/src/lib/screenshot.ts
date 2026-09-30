/**
 * A picture of the screen for feedback, taken in the browser with `html-to-image` (bundled, no
 * CDN). It draws the app's own `#root` element, so the feedback dialog (rendered outside it, in
 * a portal) is never in the picture, and only the part in the window (`viewportFrame`): what
 * she sees. Parts that stay put while the page scrolls (the side menu, marked
 * `data-screenshot-sticky`) are drawn where they are on screen.
 *
 * The picture is a JPEG, made smaller until it is at most `SCREENSHOT_MAX_BYTES` (the server's
 * limit, `app/schemas.py`).
 */
import { toCanvas } from 'html-to-image'

export const SCREENSHOT_MAX_BYTES = 700_000
const MAX_WIDTH = 1600
/** Give up on the picture after this long (the feedback goes without it). */
export const CAPTURE_TIMEOUT_MS = 10_000
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

/** Where #root sits in the window, and the picture to draw: the window's size. */
export interface Frame {
  width: number
  height: number
  /** How far to move #root so the part in the window lands at the picture's top left. */
  shiftX: number
  shiftY: number
}

/** Only the window is drawn (never the whole page: browsers can't draw canvases over 16,384
 * px, and html-to-image then silently shrinks the picture), so a long list is fine. */
export function viewportFrame(
  root: { left: number; top: number; width: number },
  view: { width: number; height: number },
): Frame {
  return {
    width: Math.max(1, Math.round(Math.min(root.width, view.width))),
    height: Math.max(1, Math.round(view.height)),
    shiftX: Math.round(root.left),
    shiftY: Math.round(root.top),
  }
}

/** The colour behind an element: its own, or the nearest parent's that isn't see-through. */
function backgroundBehind(el: HTMLElement | null): string {
  for (let node = el; node; node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor
    if (color && color !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(color)) return color
  }
  return '#ffffff'
}

function resized(source: HTMLCanvasElement, scale: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.width * scale))
  canvas.height = Math.max(1, Math.round(source.height * scale))
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

/** Encode as JPEG, lowering the quality and then the size until it fits `maxBytes`. */
export function compress(
  source: HTMLCanvasElement,
  maxBytes = SCREENSHOT_MAX_BYTES,
): Screenshot | null {
  let scale = Math.min(1, MAX_WIDTH / Math.max(1, source.width))
  for (let round = 0; round < 4; round++) {
    const canvas = resized(source, scale)
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

/** Take the picture, or null if the browser couldn't, or took longer than `timeoutMs` (the
 * feedback is then sent without it). */
export async function captureScreen({
  node = document.getElementById('root'),
  timeoutMs = CAPTURE_TIMEOUT_MS,
}: { node?: HTMLElement | null; timeoutMs?: number } = {}): Promise<Screenshot | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const tooSlow = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    return await Promise.race([take(node), tooSlow])
  } finally {
    clearTimeout(timer)
  }
}

// Anything marked `data-feedback-hide` stays out of the picture.
const keep = (el: Node) => !(el instanceof HTMLElement && el.dataset.feedbackHide !== undefined)

async function take(node: HTMLElement | null): Promise<Screenshot | null> {
  if (!node) return null
  try {
    const rect = node.getBoundingClientRect()
    const frame = viewportFrame(rect, { width: window.innerWidth, height: window.innerHeight })
    // Draw #root at its real size, moved so the window's part is at the top left of a
    // window-sized picture: exactly what she sees.
    const canvas = await toCanvas(node, {
      pixelRatio: 1,
      backgroundColor: backgroundBehind(document.body),
      width: frame.width,
      height: frame.height,
      style: {
        width: `${rect.width}px`,
        height: `${node.scrollHeight}px`,
        transform: `translate(${frame.shiftX - rect.left}px, ${frame.shiftY}px)`,
        transformOrigin: 'top left',
      },
      filter: keep,
    })
    const context = canvas.getContext('2d')
    // Parts that stay put while the page scrolls (the side menu) sit, in that drawing, where
    // they'd be with nothing scrolled. Draw each on its own and put it where it is on screen.
    for (const el of node.querySelectorAll<HTMLElement>('[data-screenshot-sticky]')) {
      if (!context || getComputedStyle(el).position !== 'sticky') continue
      const box = el.getBoundingClientRect()
      if (box.width < 1 || box.height < 1 || box.bottom <= 0 || box.top >= frame.height) continue
      const part = await toCanvas(el, {
        pixelRatio: 1,
        backgroundColor: backgroundBehind(el),
        filter: keep,
      })
      context.drawImage(part, box.left - rect.left, box.top, box.width, box.height)
    }
    return compress(canvas)
  } catch {
    return null
  }
}
