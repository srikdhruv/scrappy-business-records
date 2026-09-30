/**
 * Choose a student by typing part of their name. Students who have left are listed last, under
 * "Left", because they sometimes still pay off an old month.
 *
 * Keyboard: typing a letter opens the list with that letter searched; arrows and Enter pick.
 * Enter on the closed box submits the form when a student is already chosen, so it can never
 * silently switch to someone else. When the list opens it starts on the chosen student.
 */
import { ChevronsUpDownIcon } from 'lucide-react'
import { useId, useRef, useState, type KeyboardEvent } from 'react'

import { useStudents } from '@/api/queries'
import type { StudentRead } from '@/api/types'
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
import { studentMatches } from '@/lib/search'
import { cn } from '@/lib/utils'

const itemValue = (student: StudentRead) => `${student.name} #${student.id}`

export function StudentCombobox({
  id,
  label,
  value,
  onChange,
  placeholder = 'Choose a student',
  clearLabel,
  invalid,
  className,
  suggestedIds,
  'aria-describedby': describedBy,
}: {
  id?: string
  /** What the box is for ("Student", "Filter by student"). Read out together with the choice. */
  label: string
  value: number | null
  onChange: (studentId: number | null) => void
  placeholder?: string
  /** If set, the list starts with this option, which clears the choice (e.g. "All students"). */
  clearLabel?: string
  invalid?: boolean
  className?: string
  /** Students listed first, under "Likely", best first (e.g. for an unassigned payment). */
  suggestedIds?: number[]
  'aria-describedby'?: string
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const { data: students = [], isLoading } = useStudents('all')
  const selected = students.find((s) => s.id === value)
  const likely = (suggestedIds ?? [])
    .map((id) => students.find((s) => s.id === id))
    .filter((s): s is StudentRead => s !== undefined)
  const rest = students.filter((s) => !likely.includes(s))
  const active = rest.filter((s) => s.is_active)
  const left = rest.filter((s) => !s.is_active)
  // The same search as the Students page (lib/search.ts): name, parent, class or phone, any
  // word order, ignoring capitals, accents and the spaces in phone numbers.
  const byValue = new Map(students.map((s) => [itemValue(s), s]))
  const filter = (candidate: string, typed: string): number => {
    const student = byValue.get(candidate)
    return student && studentMatches(student, typed) ? 1 : 0
  }

  const autoId = useId()
  const buttonId = id ?? `${autoId}-button`
  const labelId = `${autoId}-label`
  const openedByTyping = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const onOpenChange = (next: boolean) => {
    if (!next) {
      setSearch('')
      openedByTyping.current = false
    }
    setOpen(next)
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key.length === 1 && /\S/.test(event.key) && !event.metaKey && !event.ctrlKey) {
      // A letter opens the list and searches for it. Keys that arrive before focus has moved
      // into the search box (fast typists) are added to the search.
      event.preventDefault()
      const key = event.key
      const append = openedByTyping.current
      openedByTyping.current = true
      setSearch((s) => (append ? s + key : key))
      setOpen(true)
    } else if (event.key === 'Enter') {
      if (open || openedByTyping.current) {
        event.preventDefault() // the list is opening: let it take the Enter
      } else if (selected && event.currentTarget.form) {
        event.preventDefault()
        event.currentTarget.form.requestSubmit()
      }
    }
  }

  const choose = (studentId: number) => {
    onChange(studentId)
    onOpenChange(false)
  }

  const renderItem = (student: StudentRead) => (
    <CommandItem
      key={student.id}
      value={itemValue(student)}
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
      {/* Read as "Student: Ananya Rao", the label and the current choice. */}
      <span id={labelId} className="sr-only">
        {label}: {selected?.name ?? placeholder}
      </span>
      <PopoverTrigger asChild>
        <Button
          id={buttonId}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          aria-labelledby={labelId}
          onKeyDown={onTriggerKeyDown}
          className={cn(
            'h-12 w-full min-w-0 justify-between bg-card px-3 font-normal hover:bg-card',
            className,
          )}
        >
          {selected ? (
            <span className="flex min-w-0 items-center gap-2.5">
              <StudentAvatar name={selected.name} size="sm" />
              <span className="truncate font-semibold">{selected.name}</span>
            </span>
          ) : (
            <span className="truncate text-muted-foreground">{placeholder}</span>
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
        {/* Starts on the chosen student, so Enter right away keeps the same one. */}
        <Command filter={filter} defaultValue={selected ? itemValue(selected) : undefined}>
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
            {likely.length > 0 && (
              <CommandGroup heading="Likely">{likely.map(renderItem)}</CommandGroup>
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
