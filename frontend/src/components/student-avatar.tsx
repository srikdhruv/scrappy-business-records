import { cn } from '@/lib/utils'

// Warm, soft backgrounds with dark text (all pass WCAG AA with --foreground).
const PALETTE = [
  'bg-[#fbe3b8]', // marigold
  'bg-[#f7d6c8]', // terracotta
  'bg-[#dcebd6]', // leaf
  'bg-[#d9ecec]', // teal
  'bg-[#efdcef]', // rose
  'bg-[#ece2cf]', // sand
]

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const first = parts[0]?.[0] ?? '?'
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : ''
  return (first + last).toUpperCase()
}

function colourFor(name: string): string {
  let hash = 0
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]!
}

/** A round badge with a student's initials, coloured consistently by name. */
export function StudentAvatar({
  name,
  size = 'md',
  className,
}: {
  name: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-extrabold text-foreground/85 select-none',
        colourFor(name),
        size === 'sm' && 'size-8 text-xs',
        size === 'md' && 'size-10 text-sm',
        size === 'lg' && 'size-16 text-xl',
        className,
      )}
    >
      {initials(name)}
    </span>
  )
}
