/**
 * Choose a student by typing part of their name. Students who have left are listed last, under
 * "Left", because they sometimes still pay off an old month.
 */
import { ChevronsUpDownIcon } from 'lucide-react'
import { useRef, useState, type KeyboardEvent } from 'react'

import { useStudents } from '@/api/queries'
import { StudentAvatar } from '@/components/student-avatar'
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
import { cn } from '@/lib/utils'

/** Show a student when every typed word appears in their name or batch (no fuzzy guessing). */
function containsWords(value: string, search: string, keywords?: string[]): number {
  const haystack = [value.replace(/ #\d+$/, ''), ...(keywords ?? [])].join(' ').toLowerCase()
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  return words.every((word) => haystack.includes(word)) ? 1 : 0
}

export function StudentCombobox({
  id,
  value,
  onChange,
  placeholder = 'Choose a student',
  clearLabel,
  invalid,
  className,
  'aria-describedby': describedBy,
  'aria-label': ariaLabel,
}: {
  id?: string
  value: number | null
  onChange: (studentId: number | null) => void
  placeholder?: string
  /** If set, the list starts with this option, which clears the choice (e.g. "All students"). */
  clearLabel?: string
  invalid?: boolean
  className?: string
  'aria-describedby'?: string
  'aria-label'?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const { data: students = [], isLoading } = useStudents('all')
  const selected = students.find((s) => s.id === value)
  const active = students.filter((s) => s.is_active)
  const left = students.filter((s) => !s.is_active)

  const openedByTyping = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const onOpenChange = (next: boolean) => {
    if (!next) {
      setSearch('')
      openedByTyping.current = false
    }
    setOpen(next)
  }

  // Typing a letter on the closed box opens it and starts the search with that letter.
  // Keys that arrive before focus has moved into the search box (fast typists) are added to the
  // search, and Enter waits for the list instead of closing it again.
  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key.length === 1 && /\S/.test(event.key) && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      const key = event.key
      const append = openedByTyping.current
      openedByTyping.current = true
      setSearch((s) => (append ? s + key : key))
      setOpen(true)
    } else if (event.key === 'Enter' && (open || openedByTyping.current)) {
      event.preventDefault()
    }
  }

  const choose = (studentId: number) => {
    onChange(studentId)
    onOpenChange(false)
  }

  const renderItem = (student: (typeof students)[number]) => (
    <CommandItem
      key={student.id}
      value={`${student.name} #${student.id}`}
      keywords={student.batch_label ? [student.batch_label] : undefined}
      data-checked={student.id === value}
      onSelect={() => choose(student.id)}
    >
      <StudentAvatar name={student.name} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold">{student.name}</span>
        {student.batch_label && (
          <span className="block truncate text-sm text-muted-foreground">
            {student.batch_label}
          </span>
        )}
      </span>
    </CommandItem>
  )

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          aria-label={ariaLabel}
          onKeyDown={onTriggerKeyDown}
          className={cn(
            'h-12 w-full justify-between bg-card px-3 font-normal hover:bg-card',
            className,
          )}
        >
          {selected ? (
            <span className="flex min-w-0 items-center gap-2.5">
              <StudentAvatar name={selected.name} size="sm" />
              <span className="truncate font-semibold">{selected.name}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDownIcon className="size-5 text-muted-foreground" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-(--radix-popover-trigger-width) min-w-72 p-0"
        align="start"
        onOpenAutoFocus={(event) => {
          // Focus the search box with the caret after any letter already typed (the default
          // would select it, so the next key would replace it).
          event.preventDefault()
          const input = inputRef.current
          input?.focus()
          input?.setSelectionRange(input.value.length, input.value.length)
        }}
      >
        <Command filter={containsWords}>
          <CommandInput
            ref={inputRef}
            placeholder="Type a name…"
            value={search}
            onValueChange={setSearch}
            aria-label="Search students"
          />
          <CommandList>
            <CommandEmpty>
              {isLoading
                ? 'Loading students…'
                : students.length === 0
                  ? 'No students yet. Add them on the Students page first.'
                  : 'No student with that name.'}
            </CommandEmpty>
            {clearLabel && !search && (
              <CommandGroup>
                <CommandItem
                  value={`__clear__ ${clearLabel}`}
                  data-checked={value === null}
                  onSelect={() => {
                    onChange(null)
                    onOpenChange(false)
                  }}
                >
                  <span className="font-semibold">{clearLabel}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {active.length > 0 && (
              <CommandGroup heading="Students">{active.map(renderItem)}</CommandGroup>
            )}
            {left.length > 0 && <CommandGroup heading="Left">{left.map(renderItem)}</CommandGroup>}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
