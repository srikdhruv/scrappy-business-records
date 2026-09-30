/**
 * Add a student (S1) or edit one (S2). Changing the fee always asks "from which month?" so that
 * earlier months keep their old fee (PRD ledger rule 7).
 */
import { InfoIcon } from 'lucide-react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { toast } from 'sonner'

import { useCreateStudent, useUpdateStudent } from '@/api/queries'
import type { StudentDetail, StudentUpdate } from '@/api/types'
import { MonthPicker } from '@/components/month-picker'
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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { errorMessage, fieldErrors } from '@/lib/errors'
import {
  currentMonth,
  formatMonth,
  formatRupees,
  paiseToRupeesInput,
  rupeesToPaise,
} from '@/lib/format'

type Field =
  'name' | 'fee' | 'feeFrom' | 'joined' | 'left' | 'phone' | 'guardian' | 'batch' | 'notes'

const SERVER_FIELDS: Record<string, Field> = {
  name: 'name',
  monthly_fee_paise: 'fee',
  fee_effective_month: 'feeFrom',
  joined_month: 'joined',
  left_month: 'left',
  phone: 'phone',
  guardian_name: 'guardian',
  batch_label: 'batch',
  notes: 'notes',
}

export function StudentFormDialog({
  open,
  onOpenChange,
  student,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Edit this student; omit to add a new one. */
  student?: StudentDetail
  onSaved?: (student: StudentDetail) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
          <StudentForm
            student={student}
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

function StudentForm({
  student,
  onDone,
}: {
  student?: StudentDetail
  onDone: (saved?: StudentDetail) => void
}) {
  const editing = student !== undefined
  const now = currentMonth()
  const [name, setName] = useState(student?.name ?? '')
  const [fee, setFee] = useState(student ? paiseToRupeesInput(student.monthly_fee_paise) : '')
  const [feeFrom, setFeeFrom] = useState<string | null>(
    student && student.joined_month > now ? student.joined_month : now,
  )
  const [joined, setJoined] = useState<string | null>(student?.joined_month ?? now)
  const [left, setLeft] = useState<string | null>(student?.left_month ?? null)
  const [phone, setPhone] = useState(student?.phone ?? '')
  const [guardian, setGuardian] = useState(student?.guardian_name ?? '')
  const [batch, setBatch] = useState(student?.batch_label ?? '')
  const [notes, setNotes] = useState(student?.notes ?? '')
  const [submitted, setSubmitted] = useState(false)
  const [serverErrors, setServerErrors] = useState<Partial<Record<Field, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)

  const createStudent = useCreateStudent()
  const updateStudent = useUpdateStudent()
  const saving = createStudent.isPending || updateStudent.isPending

  const feePaise = rupeesToPaise(fee, { allowZero: true })
  const feeChanged = editing && feePaise !== null && feePaise !== student.monthly_fee_paise

  const clientErrors: Partial<Record<Field, string>> = {}
  if (!name.trim()) clientErrors.name = 'Enter their name.'
  if (fee.trim() === '') clientErrors.fee = 'Enter the monthly fee.'
  else if (feePaise === null) clientErrors.fee = 'Enter a fee like 1500 or 1,500.'
  if (!joined) clientErrors.joined = 'Pick the month they joined.'
  if (left && joined && left < joined) {
    clientErrors.left = 'This can’t be before the month they joined.'
  }
  if (feeChanged && !feeFrom) clientErrors.feeFrom = 'Pick the month the new fee starts.'
  if (feeChanged && feeFrom && joined && feeFrom < joined) {
    clientErrors.feeFrom = 'The new fee can’t start before the month they joined.'
  }

  const errors = submitted ? { ...serverErrors, ...clientErrors } : serverErrors
  const errorId = (field: Field) => (errors[field] ? `student-${field}-error` : undefined)
  const clearServer = (field: Field) => setServerErrors((e) => ({ ...e, [field]: undefined }))

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    setFormError(null)
    if (Object.keys(clientErrors).length > 0 || saving) return
    try {
      let saved: StudentDetail
      if (editing) {
        const body: StudentUpdate = {}
        if (name.trim() !== student.name) body.name = name.trim()
        if ((phone.trim() || null) !== student.phone) body.phone = phone.trim() || null
        if ((guardian.trim() || null) !== student.guardian_name) {
          body.guardian_name = guardian.trim() || null
        }
        if ((batch.trim() || null) !== student.batch_label) body.batch_label = batch.trim() || null
        if ((notes.trim() || null) !== student.notes) body.notes = notes.trim() || null
        if (joined !== student.joined_month) body.joined_month = joined
        if (left !== student.left_month) body.left_month = left
        if (feeChanged) {
          body.monthly_fee_paise = feePaise
          body.fee_effective_month = feeFrom
        }
        saved = await updateStudent.mutateAsync({ id: student.id, body })
        toast.success('Changes saved', { description: saved.name })
      } else {
        saved = await createStudent.mutateAsync({
          name: name.trim(),
          monthly_fee_paise: feePaise!,
          joined_month: joined!,
          phone: phone.trim() || null,
          guardian_name: guardian.trim() || null,
          batch_label: batch.trim() || null,
          notes: notes.trim() || null,
        })
        toast.success(`${saved.name} added`, {
          description: `${formatRupees(saved.monthly_fee_paise)} a month from ${formatMonth(saved.joined_month)}`,
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

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{editing ? `Edit ${student.name}` : 'New student'}</DialogTitle>
        <DialogDescription>
          {editing
            ? 'Change any detail and save.'
            : 'Only the name, fee and joining month are needed. You can add the rest later.'}
        </DialogDescription>
      </DialogHeader>

      {formError && (
        <p role="alert" className="rounded-lg bg-owed-soft px-3 py-2 text-base text-owed">
          {formError}
        </p>
      )}

      <FormField id="student-name" label="Name" error={errors.name} errorId={errorId('name')}>
        <Input
          id="student-name"
          value={name}
          autoFocus
          autoComplete="off"
          placeholder="e.g. Ananya Rao"
          onChange={(e) => {
            setName(e.target.value)
            clearServer('name')
          }}
          aria-invalid={Boolean(errors.name) || undefined}
          aria-describedby={errorId('name')}
        />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="student-fee" label="Monthly fee" error={errors.fee} errorId={errorId('fee')}>
          <div className="relative">
            <span
              className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-base font-bold text-muted-foreground"
              aria-hidden
            >
              ₹
            </span>
            <Input
              id="student-fee"
              inputMode="decimal"
              autoComplete="off"
              placeholder="1500"
              value={fee}
              onChange={(e) => {
                setFee(e.target.value)
                clearServer('fee')
              }}
              aria-invalid={Boolean(errors.fee) || undefined}
              aria-describedby={errorId('fee')}
              className="pl-7 font-semibold tabular-nums"
            />
          </div>
        </FormField>
        <FormField
          id="student-joined"
          label="Joined in"
          error={errors.joined}
          errorId={errorId('joined')}
        >
          <MonthPicker
            id="student-joined"
            value={joined}
            onChange={(m) => {
              setJoined(m)
              clearServer('joined')
            }}
            invalid={Boolean(errors.joined)}
            aria-describedby={errorId('joined')}
          />
        </FormField>
      </div>

      {feeChanged && (
        <div className="grid gap-3 rounded-xl border border-primary/40 bg-primary/10 p-4">
          <FormField
            id="student-fee-from"
            label="New fee applies from"
            error={errors.feeFrom}
            errorId={errorId('feeFrom')}
          >
            <MonthPicker
              id="student-fee-from"
              value={feeFrom}
              onChange={(m) => {
                setFeeFrom(m)
                clearServer('feeFrom')
              }}
              min={joined ?? undefined}
              invalid={Boolean(errors.feeFrom)}
              aria-describedby={errorId('feeFrom') ?? 'student-fee-from-help'}
              className="sm:max-w-64"
            />
          </FormField>
          <p id="student-fee-from-help" className="flex items-start gap-2 text-base">
            <InfoIcon className="mt-0.5 size-4 shrink-0 text-primary-strong" aria-hidden />
            <span>
              From {feeFrom ? formatMonth(feeFrom) : 'that month'} they’ll owe{' '}
              <strong>{formatRupees(feePaise)}</strong> a month. Earlier months keep the old fee of{' '}
              <strong>{formatRupees(student.monthly_fee_paise)}</strong>.
            </span>
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="student-phone" label="Phone" optional error={errors.phone}>
          <Input
            id="student-phone"
            type="tel"
            autoComplete="off"
            placeholder="98765 43210"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </FormField>
        <FormField
          id="student-guardian"
          label="Parent or guardian"
          optional
          error={errors.guardian}
        >
          <Input
            id="student-guardian"
            autoComplete="off"
            value={guardian}
            onChange={(e) => setGuardian(e.target.value)}
          />
        </FormField>
      </div>

      <FormField id="student-batch" label="Class or batch" optional error={errors.batch}>
        <Input
          id="student-batch"
          autoComplete="off"
          placeholder="e.g. Tue/Thu 5pm – Indiranagar"
          value={batch}
          onChange={(e) => setBatch(e.target.value)}
        />
      </FormField>

      {editing && (
        <FormField
          id="student-left"
          label="Left in month"
          optional
          error={errors.left}
          errorId={errorId('left')}
          help="The last month they should pay for. Leave empty while they’re still coming."
        >
          <MonthPicker
            id="student-left"
            value={left}
            onChange={(m) => {
              setLeft(m)
              clearServer('left')
            }}
            placeholder="Still coming"
            clearLabel="Still coming"
            min={joined ?? undefined}
            invalid={Boolean(errors.left)}
            aria-describedby={errorId('left') ?? 'student-left-help'}
            className="sm:max-w-64"
          />
        </FormField>
      )}

      <FormField id="student-notes" label="Notes" optional error={errors.notes}>
        <Textarea
          id="student-notes"
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
          {saving ? 'Saving…' : editing ? 'Save changes' : 'Add student'}
        </Button>
      </DialogFooter>
    </form>
  )
}

function FormField({
  id,
  label,
  optional,
  error,
  errorId,
  help,
  children,
}: {
  id: string
  label: string
  optional?: boolean
  error?: string
  errorId?: string
  help?: string
  children: ReactNode
}) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id}>
        {label}
        {optional && <span className="font-normal text-muted-foreground">(optional)</span>}
      </Label>
      {children}
      {help && !error && (
        <p id={`${id}-help`} className="text-sm text-muted-foreground">
          {help}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm font-semibold text-owed">
          {error}
        </p>
      )}
    </div>
  )
}
