/**
 * A picture of the screen for feedback, taken in the browser with `html-to-image` (bundled, no
 * CDN). It draws the app's own `#root` element, so the feedback dialog (rendered outside it, in
 * a portal) is never in the picture, then keeps only the part of the page in the window: what
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

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** The part of the drawn page that is in the window: what the owner sees. */
export function visibleBox(
  page: { width: number; height: number },
  view: { scrollX: number; scrollY: number; width: number; height: number },
): Box {
  const x = Math.min(Math.max(0, view.scrollX), Math.max(0, page.width - 1))
  const y = Math.min(Math.max(0, view.scrollY), Math.max(0, page.height - 1))
  return {
    x,
    y,
    width: Math.max(1, Math.min(view.width, page.width - x)),
    height: Math.max(1, Math.min(view.height, page.height - y)),
  }
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

/** Cut the window's part out of the whole-page drawing, putting stuck parts where they are. */
function screenOnly(full: HTMLCanvasElement, root: HTMLElement): HTMLCanvasElement | null {
  const box = visibleBox(full, {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    width: window.innerWidth,
    height: window.innerHeight,
  })
  const canvas = document.createElement('canvas')
  canvas.width = box.width
  canvas.height = box.height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(full, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height)
  const rootTop = root.getBoundingClientRect().top + window.scrollY
  for (const el of root.querySelectorAll<HTMLElement>('[data-screenshot-sticky]')) {
    if (getComputedStyle(el).position !== 'sticky') continue
    const rect = el.getBoundingClientRect()
    const parent = el.parentElement?.getBoundingClientRect()
    if (!parent || rect.width <= 0 || rect.height <= 0) continue
    // In the drawing nothing scrolls, so it sits at the top of its parent.
    const sourceY = parent.top + window.scrollY - rootTop
    const sourceX = rect.left + window.scrollX
    context.drawImage(
      full,
      sourceX,
      sourceY,
      rect.width,
      rect.height,
      rect.left,
      rect.top,
      rect.width,
      rect.height,
    )
  }
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

async function take(node: HTMLElement | null): Promise<Screenshot | null> {
  if (!node) return null
  try {
    const background = getComputedStyle(document.body).backgroundColor || '#ffffff'
    const full = await toCanvas(node, {
      pixelRatio: 1,
      backgroundColor: background,
      // Anything marked `data-feedback-hide` stays out of the picture.
      filter: (el) => !(el instanceof HTMLElement && el.dataset.feedbackHide !== undefined),
    })
    const screen = screenOnly(full, node)
    return screen ? compress(screen) : null
  } catch {
    return null
  }
}
