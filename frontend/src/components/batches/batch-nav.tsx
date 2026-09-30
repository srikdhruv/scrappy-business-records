/**
 * The Students page's batch tabs: All batches | each batch | No batch.
 *
 * On a wide window they run across the top of the page (the main menu is down the left side, so
 * the two never look alike). The strip scrolls sideways when there are many batches, keeps the
 * open tab in view, and works with the keyboard: Tab to it, then ← → Home End. On a narrow
 * window, where the main menu moves to the top, it becomes one dropdown instead of a second row
 * of tabs. Every tab is a link (/students, /students/batch/3, /students/batch/none), so Back
 * works and a tab can be bookmarked.
 */
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link, useNavigate } from 'react-router'

import type { BatchRead } from '@/api/types'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { batchPath } from '@/lib/batches'
import { cn } from '@/lib/utils'

export type BatchTab = 'all' | 'none' | number

interface Item {
  tab: BatchTab
  label: string
  count?: number
  to: string
}

export function BatchNav({
  batches,
  active,
  allCount,
  noBatchCount,
  month,
}: {
  batches: readonly BatchRead[]
  active: BatchTab
  /** Students not left yet, for the "All batches" tab. */
  allCount?: number
  /** Students in no batch (not left yet). */
  noBatchCount?: number
  /** Keep the chosen month when switching tabs. */
  month?: string
}) {
  const items: Item[] = [
    { tab: 'all', label: 'All batches', count: allCount, to: batchPath(null, month) },
    ...batches.map((b) => ({
      tab: b.id,
      label: b.name,
      count: b.active_student_count,
      to: batchPath(b.id, month),
    })),
    { tab: 'none', label: 'No batch', count: noBatchCount, to: batchPath('none', month) },
  ]
  return (
    <>
      <div className="mb-6 lg:hidden">
        <BatchSelect items={items} active={active} />
      </div>
      <div className="mb-6 hidden lg:block">
        <BatchTabs items={items} active={active} />
      </div>
    </>
  )
}

function BatchTabs({ items, active }: { items: Item[]; active: BatchTab }) {
  const scroller = useRef<HTMLUListElement>(null)
  const activeRef = useRef<HTMLAnchorElement>(null)
  const [edges, setEdges] = useState({ start: false, end: false })

  const measure = () => {
    const el = scroller.current
    if (!el) return
    setEdges({
      start: el.scrollLeft > 4,
      end: el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
    })
  }

  // Keep the open tab in view (after a click, Back, or following a link to a batch).
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
    measure()
  }, [active, items.length])

  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const links = [...(scroller.current?.querySelectorAll<HTMLAnchorElement>('a') ?? [])]
    const i = links.indexOf(document.activeElement as HTMLAnchorElement)
    if (i < 0) return
    const next =
      event.key === 'ArrowRight'
        ? Math.min(i + 1, links.length - 1)
        : event.key === 'ArrowLeft'
          ? Math.max(i - 1, 0)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? links.length - 1
              : null
    if (next === null) return
    event.preventDefault()
    links[next]?.focus()
    links[next]?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }

  const scrollBy = (direction: 1 | -1) => {
    const el = scroller.current
    el?.scrollBy?.({ left: direction * el.clientWidth * 0.7, behavior: 'smooth' })
  }

  return (
    <nav aria-label="Batches" className="relative">
      <ul
        ref={scroller}
        onScroll={measure}
        onKeyDown={onKeyDown}
        className="flex scroll-px-10 [scrollbar-width:none] gap-1 overflow-x-auto border-b border-border [&::-webkit-scrollbar]:hidden"
      >
        {items.map((item) => {
          const current = item.tab === active
          return (
            <li key={String(item.tab)} className="shrink-0">
              <Link
                ref={current ? activeRef : undefined}
                to={item.to}
                aria-current={current ? 'page' : undefined}
                title={item.label.length > 28 ? item.label : undefined}
                className={cn(
                  '-mb-px flex max-w-72 items-center gap-2 rounded-t-xl border-b-3 px-4 pt-2.5 pb-2 text-base font-bold whitespace-nowrap transition-colors',
                  'outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset',
                  current
                    ? 'border-primary bg-card text-foreground'
                    : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  item.tab === 'none' && !current && 'italic',
                )}
              >
                <span className="truncate">{item.label}</span>
                {item.count !== undefined && (
                  <span
                    className={cn(
                      'rounded-full px-2 text-sm tabular-nums',
                      current ? 'bg-primary/25 text-primary-foreground' : 'bg-muted',
                    )}
                  >
                    {item.count}
                  </span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
      {edges.start && <ScrollButton side="start" onClick={() => scrollBy(-1)} />}
      {edges.end && <ScrollButton side="end" onClick={() => scrollBy(1)} />}
    </nav>
  )
}

/** A soft fade at an edge that has more tabs past it, with an arrow to scroll there. */
function ScrollButton({ side, onClick }: { side: 'start' | 'end'; onClick: () => void }) {
  const Icon = side === 'start' ? ChevronLeftIcon : ChevronRightIcon
  return (
    <div
      className={cn(
        'pointer-events-none absolute top-0 bottom-px flex w-16 items-center',
        side === 'start'
          ? 'left-0 justify-start bg-linear-to-r from-background via-background/90 to-transparent'
          : 'right-0 justify-end bg-linear-to-l from-background via-background/90 to-transparent',
      )}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        onClick={onClick}
        className="pointer-events-auto flex size-8 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-soft hover:text-foreground"
      >
        <Icon className="size-5" />
      </button>
    </div>
  )
}

function BatchSelect({ items, active }: { items: Item[]; active: BatchTab }) {
  const navigate = useNavigate()
  const byValue = new Map(items.map((item) => [String(item.tab), item]))
  const [first, ...rest] = items
  const last = rest.pop()
  return (
    <Select
      value={String(active)}
      onValueChange={(value) => {
        const item = byValue.get(value)
        if (item) void navigate(item.to)
      }}
    >
      <SelectTrigger aria-label="Batch" className="h-12 w-full bg-card text-base font-bold">
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" className="max-h-[60vh]">
        {first && <Option item={first} />}
        {rest.length > 0 && (
          <SelectGroup>
            <SelectLabel>Batches</SelectLabel>
            {rest.map((item) => (
              <Option key={String(item.tab)} item={item} />
            ))}
          </SelectGroup>
        )}
        {last && <Option item={last} />}
      </SelectContent>
    </Select>
  )
}

function Option({ item }: { item: Item }) {
  return (
    <SelectItem value={String(item.tab)}>
      <span className="truncate">{item.label}</span>
      {item.count !== undefined && (
        <span className="ml-1 text-muted-foreground tabular-nums">({item.count})</span>
      )}
    </SelectItem>
  )
}
