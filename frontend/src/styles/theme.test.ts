/**
 * Guards the warm theme's text contrast (WCAG AA: 4.5:1 for normal text). The colours live as
 * hex CSS variables in src/index.css; if you add a text/background pairing, add it here.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Vitest runs from frontend/.
const css = readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8')

const rootBlock = /:root\s*{([^}]*)}/.exec(css)?.[1] ?? ''
const tokens = Object.fromEntries(
  [...rootBlock.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]),
)

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

// [text token, background token]
const PAIRS: [string, string][] = [
  ['foreground', 'background'],
  ['foreground', 'card'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['muted-foreground', 'sidebar'],
  ['primary-foreground', 'primary'],
  ['primary-strong', 'background'],
  ['primary-strong', 'card'],
  ['accent-foreground', 'accent'],
  ['terracotta', 'background'],
  ['terracotta', 'card'],
  ['terracotta-foreground', 'terracotta'],
  ['secondary-foreground', 'secondary'],
  ['destructive', 'background'],
  ['destructive', 'card'],
  ['paid', 'paid-soft'],
  ['paid', 'card'],
  ['partial', 'partial-soft'],
  ['partial', 'card'],
  ['owed', 'owed-soft'],
  ['owed', 'card'],
  ['credit', 'credit-soft'],
  ['credit', 'card'],
  ['sidebar-foreground', 'sidebar'],
  ['sidebar-accent-foreground', 'sidebar-accent'],
  ['sidebar-primary-foreground', 'sidebar-primary'],
]

describe('theme contrast', () => {
  it.each(PAIRS)('%s on %s meets WCAG AA', (fg, bg) => {
    expect(tokens[fg], `--${fg} missing`).toBeDefined()
    expect(tokens[bg], `--${bg} missing`).toBeDefined()
    expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(4.5)
  })

  it('does not pair white text with marigold', () => {
    expect(contrast('#ffffff', tokens['primary']!)).toBeLessThan(4.5)
    expect(tokens['primary-foreground']).not.toMatch(/^#f{6}$/i)
  })
})
