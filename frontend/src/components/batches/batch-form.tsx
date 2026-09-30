/**
 * New batch and Edit batch. Only the name is needed. The usual fee only fills in the fee of a
 * student added to the batch: every student keeps their own fee. So changing it here changes no
 * one's fee, unless the owner ticks "Also charge it to…", which lists exactly whose fee changes
 * and from which month (a normal fee change for each, as in Edit student). Students paying
 * their own fee (a discount) are named and left alone.
 */
import { InfoIcon } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { toast } from 'sonner'

import {
  useBatches,
  useCreateBatch,
  useServerMonth,
  useStudents,
  useUpdateBatch,
} from '@/api/queries'
import type { BatchRead, BatchUpdate, StudentRead, Weekday } from '@/api/types'
import { MonthPicker } from '@/components/month-picker'
import { FormField } from '@/components/student-form'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { amountProblem } from '@/lib/amount'
import { feeChangeFor, locationsOf, WEEKDAYS } from '@/lib/batches'
import { errorMessage, fieldErrors } from '@/lib/errors'
import {
  addMonths,
  currentMonth,
  formatMonth,
  formatRupees,
  MONTHS_AHEAD,
  paiseToRupeesInput,
  rupeesToPaise,
} from '@/lib/format'
import { plural } from '@/lib/labels'

type Field = 'name' | 'location' | 'days' | 'start' | 'end' | 'fee' | 'notes' | 'apply'

const SERVER_FIELDS: Record<string, Field> = {
  name: 'name',
  location: 'location',
  days: 'days',
  start_time: 'start',
  end_time: 'end',
  default_fee_paise: 'fee',
  notes: 'notes',
  apply_fee: 'apply',
  'apply_fee.from_month': 'apply',
  'apply_fee.student_ids': 'apply',
}

export function BatchFormDialog({
  open,
  onOpenChange,
  batch,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Edit this batch; omit to add a new one. */
  batch?: BatchRead
  onSaved?: (batch: BatchRead) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
          <BatchForm
            batch={batch}
            onDone={(saved) => {
              onOpenChange(false)
              if (saved) onSaved?.(saved)
            }}
          />
        </DialogContent>
      )}
    </Dialog>
  )
}

function BatchForm({ batch, onDone }: { batch?: BatchRead; onDone: (saved?: BatchRead) => void }) {
  const editing = batch !== undefined
  const now = useServerMonth() ?? currentMonth()
  const { data: batches = [] } = useBatches()
  const { data: students = [] } = useStudents('all')
  const [name, setName] = useState(batch?.name ?? '')
  const [location, setLocation] = useState(batch?.location ?? '')
  const [days, setDays] = useState<Weekday[]>(batch?.days ?? [])
  const [start, setStart] = useState(batch?.start_time ?? '')
  const [end, setEnd] = useState(batch?.end_time ?? '')
  const [fee, setFee] = useState(
    batch?.default_fee_paise != null ? paiseToRupeesInput(batch.default_fee_paise) : '',
  )
  const [notes, setNotes] = useState(batch?.notes ?? '')
  const [apply, setApply] = useState(false)
  const [applyFrom, setApplyFrom] = useState<string | null>(now)
  const [submitted, setSubmitted] = useState(false)
  const [serverErrors, setServerErrors] = useState<Partial<Record<Field, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)

  const createBatch = useCreateBatch()
  const updateBatch = useUpdateBatch()
  const saving = createBatch.isPending || updateBatch.isPending

  const feePaise = fee.trim() === '' ? null : rupeesToPaise(fee, { allowZero: true })
  const feeChanged = editing && feePaise !== null && feePaise !== batch.default_fee_paise
  const affected = feeChanged ? feeChangeFor(students, batch, feePaise) : null
  const canApply = affected !== null && affected.change.length > 0

  const clientErrors: Partial<Record<Field, string>> = {}
  if (!name.trim()) clientErrors.name = 'Give the batch a name.'
  const clash = batches.find(
    (b) => b.id !== batch?.id && b.name.trim().toLowerCase() === name.trim().toLowerCase(),
  )
  if (clash) clientErrors.name = `There's already a batch called ${clash.name}.`
  if (start && end && end <= start) clientErrors.end = 'The end time must be after the start time.'
  const feeError = fee.trim() ? amountProblem(fee, { allowZero: true, what: 'fee' }) : null
  if (feeError) clientErrors.fee = feeError
  if (apply && canApply && !applyFrom) clientErrors.apply = 'Pick the month the new fee starts.'

  const errors = submitted ? { ...serverErrors, ...clientErrors } : serverErrors
  const errorId = (field: Field) => (errors[field] ? `batch-${field}-error` : undefined)
  const clearServer = (field: Field) => setServerErrors((e) => ({ ...e, [field]: undefined }))

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    setFormError(null)
    if (Object.keys(clientErrors).length > 0 || saving) return
    const fields = {
      name: name.trim(),
      location: location.trim() || null,
      days,
      start_time: start || null,
      end_time: end || null,
      default_fee_paise: feePaise,
      notes: notes.trim() || null,
    }
    try {
      let saved: BatchRead
      if (editing) {
        const body: BatchUpdate = {}
        if (fields.name !== batch.name) body.name = fields.name
        if (fields.location !== batch.location) body.location = fields.location
        if (fields.days.join() !== batch.days.join()) body.days = fields.days
        if (fields.start_time !== batch.start_time) body.start_time = fields.start_time
        if (fields.end_time !== batch.end_time) body.end_time = fields.end_time
        if (fields.default_fee_paise !== batch.default_fee_paise) {
          body.default_fee_paise = fields.default_fee_paise
        }
        if (fields.notes !== batch.notes) body.notes = fields.notes
        const charged = apply && canApply && applyFrom && feePaise !== null
        if (charged) {
          body.apply_fee = {
            from_month: applyFrom,
            student_ids: affected.change.map((s) => s.id),
          }
        }
        saved = await updateBatch.mutateAsync({ id: batch.id, body })
        toast.success('Batch saved', {
          description: charged
            ? `${saved.name}: ${formatRupees(feePaise)} a month from ${formatMonth(applyFrom)} for ${plural(affected.change.length, 'student')}`
            : saved.name,
        })
      } else {
        saved = await createBatch.mutateAsync(fields)
        toast.success(`${saved.name} added`, {
          description: 'Add students to it from its tab, or from their Edit form.',
        })
      }
      onDone(saved)
    } catch (error) {
      const byField: Partial<Record<Field, string>> = {}
      for (const [key, msg] of Object.entries(fieldErrors(error))) {
        const field = SERVER_FIELDS[key]
        if (field) byField[field] = msg
      }
      setServerErrors(byField)
      if (Object.keys(byField).length === 0) setFormError(errorMessage(error))
    }
  }

  const places = locationsOf(batches)

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{editing ? `Edit ${batch.name}` : 'New batch'}</DialogTitle>
        <DialogDescription>
          {editing
            ? 'Change any detail and save.'
            : 'Only the name is needed. The rest helps you tell batches apart.'}
        </DialogDescription>
      </DialogHeader>

      {formError && (
        <p role="alert" className="rounded-lg bg-owed-soft px-3 py-2 text-base text-owed">
          {formError}
        </p>
      )}

      <FormField id="batch-name" label="Name" error={errors.name} errorId={errorId('name')}>
        <Input
          id="batch-name"
          value={name}
          autoFocus
          autoComplete="off"
          placeholder="e.g. Mon/Wed Evening"
          maxLength={200}
          onChange={(e) => {
            setName(e.target.value)
            clearServer('name')
          }}
          aria-invalid={Boolean(errors.name) || undefined}
          aria-describedby={errorId('name')}
        />
      </FormField>

      <FormField id="batch-location" label="Location" optional error={errors.location}>
        <Input
          id="batch-location"
          value={location}
          autoComplete="off"
          placeholder="e.g. Koramangala studio"
          list="batch-locations"
          maxLength={200}
          onChange={(e) => setLocation(e.target.value)}
        />
        <datalist id="batch-locations">
          {places.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </FormField>

      <FormField id="batch-days" label="Days" optional error={errors.days}>
        <ToggleGroup
          id="batch-days"
          type="multiple"
          variant="outline"
          value={days}
          onValueChange={(v) => setDays(WEEKDAYS.map((d) => d.value).filter((d) => v.includes(d)))}
          aria-label="Days it meets"
          className="flex-wrap justify-start"
        >
          {WEEKDAYS.map((d) => (
            <ToggleGroupItem
              key={d.value}
              value={d.value}
              aria-label={d.long}
              className="h-11 min-w-14 px-3 text-base font-bold data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
            >
              {d.short}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="batch-start" label="Starts at" optional error={errors.start}>
          <Input
            id="batch-start"
            type="time"
            value={start}
            onChange={(e) => {
              setStart(e.target.value)
              clearServer('start')
            }}
          />
        </FormField>
        <FormField
          id="batch-end"
          label="Ends at"
          optional
          error={errors.end}
          errorId={errorId('end')}
        >
          <Input
            id="batch-end"
            type="time"
            value={end}
            onChange={(e) => {
              setEnd(e.target.value)
              clearServer('end')
            }}
            aria-invalid={Boolean(errors.end) || undefined}
            aria-describedby={errorId('end')}
          />
        </FormField>
      </div>

      <FormField
        id="batch-fee"
        label="Usual monthly fee"
        optional
        error={errors.fee}
        errorId={errorId('fee')}
        help="Filled in for a new student in this batch. Each student keeps their own fee."
      >
        <div className="relative sm:max-w-64">
          <span
            className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-base font-bold text-muted-foreground"
            aria-hidden
          >
            ₹
          </span>
          <Input
            id="batch-fee"
            inputMode="decimal"
            autoComplete="off"
            placeholder="1500"
            value={fee}
            onChange={(e) => {
              setFee(e.target.value)
              clearServer('fee')
            }}
            aria-invalid={Boolean(errors.fee) || undefined}
            aria-describedby={errorId('fee') ?? 'batch-fee-help'}
            className="pl-7 font-semibold tabular-nums"
          />
        </div>
      </FormField>

      {feeChanged && affected && (
        <ApplyFeeBox
          fee={feePaise}
          affected={affected}
          apply={apply}
          onApplyChange={setApply}
          from={applyFrom}
          onFromChange={(m) => {
            setApplyFrom(m)
            clearServer('apply')
          }}
          now={now}
          error={errors.apply}
        />
      )}

      <FormField id="batch-notes" label="Notes" optional error={errors.notes}>
        <Textarea
          id="batch-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
        />
      </FormField>

      <DialogFooter>
        <Button type="button" variant="outline" size="lg" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button type="submit" size="lg" disabled={saving} className="min-w-36 font-bold">
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Add batch'}
        </Button>
      </DialogFooter>
    </form>
  )
}

const listNames = (students: readonly StudentRead[]) =>
  students.map((s) => `${s.name} (${formatRupees(s.monthly_fee_paise)})`).join(', ')

function ApplyFeeBox({
  fee,
  affected,
  apply,
  onApplyChange,
  from,
  onFromChange,
  now,
  error,
}: {
  fee: number
  affected: { change: StudentRead[]; ownFee: StudentRead[] }
  apply: boolean
  onApplyChange: (apply: boolean) => void
  from: string | null
  onFromChange: (month: string | null) => void
  now: string
  error?: string
}) {
  const { change, ownFee } = affected
  return (
    <div className="grid gap-3 rounded-xl border border-primary/40 bg-primary/10 p-4 text-base">
      <p className="flex items-start gap-2">
        <InfoIcon className="mt-1 size-4 shrink-0 text-primary-strong" aria-hidden />
        <span>
          Changing the usual fee doesn’t change what anyone in this batch pays.
          {change.length === 0 && ' Everyone in it already pays their own fee.'}
        </span>
      </p>
      {change.length > 0 && (
        <>
          <label className="flex items-start gap-2.5 font-bold">
            <input
              type="checkbox"
              className="mt-1 size-4 accent-current"
              checked={apply}
              onChange={(e) => onApplyChange(e.target.checked)}
            />
            <span>
              Also charge {formatRupees(fee)} to {plural(change.length, 'student')} in this batch
            </span>
          </label>
          {apply && (
            <div className="grid gap-3 pl-6">
              <FormField
                id="batch-apply-from"
                label="From"
                error={error}
                errorId={error ? 'batch-apply-error' : undefined}
              >
                <MonthPicker
                  id="batch-apply-from"
                  label="New fee from"
                  current={now}
                  max={addMonths(now, MONTHS_AHEAD)}
                  value={from}
                  onChange={onFromChange}
                  invalid={Boolean(error)}
                  className="sm:max-w-64"
                />
              </FormField>
              <p>
                <strong>Changes:</strong> {listNames(change)}.{' '}
                {from &&
                  `Their fee is ${formatRupees(fee)} from ${formatMonth(from)}; months before it don’t change.`}
              </p>
            </div>
          )}
          {ownFee.length > 0 && (
            <p className="text-muted-foreground">
              <strong className="text-foreground">Keep their own fee:</strong> {listNames(ownFee)}.
            </p>
          )}
        </>
      )}
    </div>
  )
}
