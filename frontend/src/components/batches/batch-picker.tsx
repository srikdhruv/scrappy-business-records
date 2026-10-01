/**
 * Choose a student's batch: type part of its name, place or day ("sat", "kora"), and pick it.
 * Each batch shows its days and times, so two with similar names can be told apart. "No batch"
 * is always first.
 */
import { ChevronsUpDownIcon } from 'lucide-react'
import { useId, useState } from 'react'

import { useBatches } from '@/api/queries'
import type { BatchRead } from '@/api/types'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { batchMatches, formatSchedule } from '@/lib/batches'
import { formatRupees } from '@/lib/format'
import { fold } from '@/lib/search'
import { cn } from '@/lib/utils'

const NONE = '__none__'
const itemValue = (b: BatchRead) => `${b.name} #${b.id}`

export function BatchPicker({
  id,
  value,
  onChange,
  invalid,
  className,
  'aria-describedby': describedBy,
}: {
  id?: string
  value: number | null
  onChange: (batch: BatchRead | null) => void
  invalid?: boolean
  className?: string
  'aria-describedby'?: string
}) {
  const [open, setOpen] = useState(false)
  const { data: batches = [], isLoading } = useBatches()
  const selected = batches.find((b) => b.id === value)
  const byValue = new Map(batches.map((b) => [itemValue(b), b]))
  const labelId = useId()

  const filter = (candidate: string, typed: string): number => {
    if (candidate === NONE) return fold('no batch').includes(fold(typed).trim()) ? 1 : 0
    const batch = byValue.get(candidate)
    return batch && batchMatches(batch, typed) ? 1 : 0
  }
  const choose = (batch: BatchRead | null) => {
    onChange(batch)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span id={labelId} className="sr-only">
        Batch: {selected?.name ?? 'No batch'}
      </span>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          aria-labelledby={labelId}
          aria-describedby={describedBy}
          className={cn(
            'h-auto min-h-12 w-full min-w-0 justify-between bg-card px-3 py-2 text-left font-normal hover:bg-card',
            className,
          )}
        >
          {selected ? (
            <span className="min-w-0">
              <span className="block truncate font-semibold">{selected.name}</span>
              <BatchDetail batch={selected} />
            </span>
          ) : (
            <span className="text-muted-foreground">No batch</span>
          )}
          <ChevronsUpDownIcon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-(--radix-popover-trigger-width) min-w-72 p-0" align="start">
        <Command filter={filter} defaultValue={selected ? itemValue(selected) : NONE}>
          <CommandInput placeholder="Type a batch, place or day…" aria-label="Search batches" />
          <CommandList>
            <CommandEmpty>
              {isLoading ? 'Loading batches…' : 'No batch like that. Add it on the Students page.'}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem value={NONE} data-checked={value === null} onSelect={() => choose(null)}>
                <span className="font-semibold">No batch</span>
              </CommandItem>
            </CommandGroup>
            {batches.length > 0 && (
              <CommandGroup heading="Batches">
                {batches.map((b) => (
                  <CommandItem
                    key={b.id}
                    value={itemValue(b)}
                    data-checked={b.id === value}
                    onSelect={() => choose(b)}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{b.name}</span>
                      <BatchDetail batch={b} />
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function BatchDetail({ batch }: { batch: BatchRead }) {
  const text = [
    formatSchedule(batch),
    batch.location,
    batch.default_fee_paise !== null ? `${formatRupees(batch.default_fee_paise)} a month` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return text ? <span className="block truncate text-sm text-muted-foreground">{text}</span> : null
}
