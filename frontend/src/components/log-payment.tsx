/**
 * The app-wide "+ Log payment" form (PRD: visible on every page; D5: one click from the
 * dashboard). Anything can open it, optionally prefilled:
 *
 *   const { openLogPayment, openEditPayment } = useLogPayment()
 *   openLogPayment({ studentId: 3, forMonth: '2026-10', amountPaise: 150000 })
 *   openEditPayment(payment)
 *
 * The dialog is rendered once, inside <LogPaymentProvider>.
 */
import {
  BanknoteIcon,
  CircleEllipsisIcon,
  LightbulbIcon,
  PlusIcon,
  SmartphoneIcon,
} from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'

import {
  useCreatePayment,
  useDeletePayment,
  useStudent,
  useSuggestedPayment,
  useUpdatePayment,
} from '@/api/queries'
import type { PaymentMethod, PaymentRead } from '@/api/types'
import { MonthPicker } from '@/components/month-picker'
import { StudentCombobox } from '@/components/student-combobox'
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { errorMessage, fieldErrors } from '@/lib/errors'
import {
  addMonths,
  currentMonth,
  formatMonth,
  formatRupees,
  paiseToRupeesInput,
  rupeesToPaise,
  today,
} from '@/lib/format'
import { cn } from '@/lib/utils'

export interface LogPaymentPrefill {
  studentId?: number
  forMonth?: string
  amountPaise?: number
}

interface LogPaymentContextValue {
  openLogPayment: (prefill?: LogPaymentPrefill) => void
  openEditPayment: (payment: PaymentRead) => void
}

type DialogState =
  | { open: false; key: number }
  | { open: true; key: number; mode: 'create'; prefill: LogPaymentPrefill }
  | { open: true; key: number; mode: 'edit'; payment: PaymentRead }

const LogPaymentContext = createContext<LogPaymentContextValue | null>(null)

export function LogPaymentProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>({ open: false, key: 0 })

  const openLogPayment = useCallback((prefill: LogPaymentPrefill = {}) => {
    setState((s) => ({ open: true, key: s.key + 1, mode: 'create', prefill }))
  }, [])
  const openEditPayment = useCallback((payment: PaymentRead) => {
    setState((s) => ({ open: true, key: s.key + 1, mode: 'edit', payment }))
  }, [])
  const close = useCallback(() => setState((s) => ({ open: false, key: s.key })), [])

  const value = useMemo(
    () => ({ openLogPayment, openEditPayment }),
    [openLogPayment, openEditPayment],
  )
  return (
    <LogPaymentContext.Provider value={value}>
      {children}
      <Dialog open={state.open} onOpenChange={(open) => !open && close()}>
        {state.open && (
          <DialogContent className="sm:max-w-xl" aria-describedby={undefined}>
            <PaymentForm
              key={state.key}
              mode={state.mode}
              prefill={state.mode === 'create' ? state.prefill : undefined}
              payment={state.mode === 'edit' ? state.payment : undefined}
              onDone={close}
            />
          </DialogContent>
        )}
      </Dialog>
    </LogPaymentContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useLogPayment(): LogPaymentContextValue {
  const ctx = useContext(LogPaymentContext)
  if (!ctx) throw new Error('useLogPayment must be used inside <LogPaymentProvider>')
  return ctx
}

export function LogPaymentButton({
  className,
  prefill,
  size = 'lg',
  variant = 'default',
  label = 'Log payment',
}: {
  className?: string
  prefill?: LogPaymentPrefill
  size?: 'default' | 'sm' | 'lg'
  variant?: 'default' | 'outline' | 'secondary'
  label?: string
}) {
  const { openLogPayment } = useLogPayment()
  return (
    <Button
      size={size}
      variant={variant}
      className={cn(variant === 'default' && 'font-bold shadow-sm', className)}
      onClick={() => openLogPayment(prefill)}
    >
      <PlusIcon strokeWidth={2.75} aria-hidden />
      {label}
    </Button>
  )
}

// ---- The form -----------------------------------------------------------------------------------

const METHODS: { value: PaymentMethod; label: string; icon: typeof SmartphoneIcon }[] = [
  { value: 'upi', label: 'UPI', icon: SmartphoneIcon },
  { value: 'cash', label: 'Cash', icon: BanknoteIcon },
  { value: 'other', label: 'Other', icon: CircleEllipsisIcon },
]

type Field = 'student' | 'amount' | 'paidOn' | 'forMonth' | 'method' | 'note'

const SERVER_FIELDS: Record<string, Field> = {
  student_id: 'student',
  amount_paise: 'amount',
  paid_on: 'paidOn',
  for_month: 'forMonth',
  method: 'method',
  note: 'note',
}

function validate(values: {
  studentId: number | null
  amount: string
  paidOn: string
  forMonth: string | null
}): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {}
  if (values.studentId === null) errors.student = 'Choose who paid.'
  const paise = rupeesToPaise(values.amount, { allowZero: true })
  if (values.amount.trim() === '') errors.amount = 'Enter the amount.'
  else if (paise === null) errors.amount = 'Enter an amount like 1500 or 1,500.'
  else if (paise <= 0) errors.amount = 'The amount must be more than ₹0.'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.paidOn)) errors.paidOn = 'Enter the date they paid.'
  else if (values.paidOn > today()) errors.paidOn = 'This date is in the future.'
  if (!values.forMonth) errors.forMonth = 'Pick the month this payment is for.'
  return errors
}

function PaymentForm({
  mode,
  prefill,
  payment,
  onDone,
}: {
  mode: 'create' | 'edit'
  prefill?: LogPaymentPrefill
  payment?: PaymentRead
  onDone: () => void
}) {
  const [studentId, setStudentId] = useState<number | null>(
    payment?.student_id ?? prefill?.studentId ?? null,
  )
  const [amount, setAmount] = useState(() => {
    const paise = payment?.amount_paise ?? prefill?.amountPaise
    return paise ? paiseToRupeesInput(paise) : ''
  })
  const [paidOn, setPaidOn] = useState(payment?.paid_on ?? today())
  const [forMonth, setForMonth] = useState<string | null>(
    payment?.for_month ?? prefill?.forMonth ?? null,
  )
  const [method, setMethod] = useState<PaymentMethod>(payment?.method ?? 'upi')
  const [note, setNote] = useState(payment?.note ?? '')
  const [submitted, setSubmitted] = useState(false)
  const [serverErrors, setServerErrors] = useState<Partial<Record<Field, string>>>({})
  const [formError, setFormError] = useState<string | null>(null)

  // When a student is picked, the suggestion fills in the amount and month. It never overwrites
  // what the person typed, or what the caller prefilled for that same student (e.g. the
  // dashboard's "Log payment" button, which already knows the month and what's left).
  const [amountEdited, setAmountEdited] = useState(false)
  const [monthEdited, setMonthEdited] = useState(false)
  const [suggestedFor, setSuggestedFor] = useState<number | null>(null)

  const suggestion = useSuggestedPayment(mode === 'create' ? (studentId ?? undefined) : undefined)
  const student = useStudent(studentId ?? undefined)

  if (
    mode === 'create' &&
    studentId !== null &&
    suggestedFor !== studentId &&
    suggestion.data &&
    !suggestion.isFetching
  ) {
    const prefilledFor = studentId === prefill?.studentId
    setSuggestedFor(studentId)
    // Nothing owed (null) leaves the field empty rather than guessing.
    const { amount_paise: suggestedAmount, for_month: suggestedMonth } = suggestion.data
    const keepAmount = amountEdited || (prefilledFor && prefill?.amountPaise !== undefined)
    if (!keepAmount) setAmount(suggestedAmount ? paiseToRupeesInput(suggestedAmount) : '')
    const keepMonth = monthEdited || (prefilledFor && prefill?.forMonth !== undefined)
    if (!keepMonth) setForMonth(suggestedMonth)
  }

  const createPayment = useCreatePayment()
  const updatePayment = useUpdatePayment()
  const deletePayment = useDeletePayment()
  const saving = createPayment.isPending || updatePayment.isPending

  const clientErrors = validate({ studentId, amount, paidOn, forMonth })
  const errors: Partial<Record<Field, string>> = submitted
    ? { ...serverErrors, ...clientErrors }
    : serverErrors
  const errorId = (field: Field) => (errors[field] ? `payment-${field}-error` : undefined)

  const pickStudent = (id: number | null) => {
    setStudentId(id)
    setServerErrors((e) => ({ ...e, student: undefined }))
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitted(true)
    setFormError(null)
    if (Object.keys(clientErrors).length > 0 || saving) return
    const body = {
      student_id: studentId!,
      amount_paise: rupeesToPaise(amount)!,
      paid_on: paidOn,
      for_month: forMonth!,
      method,
      note: note.trim() || null,
    }
    try {
      const studentName = student.data?.name ?? 'the student'
      const summary = `${formatRupees(body.amount_paise)} from ${studentName} for ${formatMonth(body.for_month)}`
      if (mode === 'edit' && payment) {
        await updatePayment.mutateAsync({ id: payment.id, body })
        toast.success('Payment updated', { description: summary })
      } else {
        const created = await createPayment.mutateAsync(body)
        toast.success('Payment saved', {
          description: summary,
          action: {
            label: 'Undo',
            onClick: () =>
              deletePayment.mutate(created.id, {
                onSuccess: () => toast('Payment removed'),
                onError: (error) => toast.error(errorMessage(error)),
              }),
          },
        })
      }
      onDone()
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

  const monthRow = student.data?.months.find((m) => m.month === forMonth)
  const now = currentMonth()
  const suggested = mode === 'create' && !suggestion.isFetching ? suggestion.data : undefined
  const hint = (() => {
    if (!suggested) return null
    const m = suggested.for_month
    if (m === null) return 'All paid up. Nothing is owed right now.'
    if (forMonth === m) {
      if (m < now) return `Oldest unpaid: ${formatMonth(m)}`
      if (m > now) return `All paid up. Next due: ${formatMonth(m)}`
      return `Due now: ${formatMonth(m)}`
    }
    // Opened for a later month while an older one is still owed: point it out.
    if (m < now && forMonth !== null && m < forMonth) return `Oldest unpaid: ${formatMonth(m)}`
    return null
  })()
  const switchMonth = suggested?.for_month ?? null
  const canSwitch = hint !== null && switchMonth !== null && forMonth !== switchMonth

  const switchToSuggested = () => {
    if (!suggested?.for_month) return
    setForMonth(suggested.for_month)
    if (suggested.amount_paise) setAmount(paiseToRupeesInput(suggested.amount_paise))
    setMonthEdited(true)
    setAmountEdited(true)
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{mode === 'edit' ? 'Edit payment' : 'Log a payment'}</DialogTitle>
        <DialogDescription>
          {mode === 'edit'
            ? 'Fix any detail and save.'
            : 'Record money you’ve received from a student.'}
        </DialogDescription>
      </DialogHeader>

      {formError && (
        <p role="alert" className="rounded-lg bg-owed-soft px-3 py-2 text-base text-owed">
          {formError}
        </p>
      )}

      <div className="grid gap-2">
        <Label htmlFor="payment-student">Student</Label>
        <StudentCombobox
          id="payment-student"
          value={studentId}
          onChange={pickStudent}
          invalid={Boolean(errors.student)}
          aria-describedby={errorId('student')}
        />
        <FieldError id={errorId('student')} message={errors.student} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-2">
          <Label htmlFor="payment-amount">Amount</Label>
          <div className="relative">
            <span
              className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-lg font-bold text-muted-foreground"
              aria-hidden
            >
              ₹
            </span>
            <Input
              id="payment-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value)
                setAmountEdited(true)
                setServerErrors((s) => ({ ...s, amount: undefined }))
              }}
              aria-invalid={Boolean(errors.amount) || undefined}
              aria-describedby={errorId('amount')}
              className="h-12 pl-8 text-xl font-bold tabular-nums"
            />
          </div>
          <FieldError id={errorId('amount')} message={errors.amount} />
        </div>
        <div className="grid content-start gap-2">
          <Label htmlFor="payment-month">For month</Label>
          <MonthPicker
            id="payment-month"
            value={forMonth}
            onChange={(m) => {
              setForMonth(m)
              setMonthEdited(true)
              setServerErrors((s) => ({ ...s, forMonth: undefined }))
            }}
            min="2000-01"
            max={addMonths(currentMonth(), 24)}
            invalid={Boolean(errors.forMonth)}
            aria-describedby={errorId('forMonth') ?? (hint ? 'payment-month-hint' : undefined)}
            className="h-12"
          />
          <FieldError id={errorId('forMonth')} message={errors.forMonth} />
        </div>
      </div>

      {(hint || monthRow) && (
        <div
          id="payment-month-hint"
          className="-mt-1 grid gap-1.5 rounded-xl bg-muted/60 px-4 py-3 text-base"
          aria-live="polite"
        >
          {hint && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="inline-flex items-center gap-1.5 font-semibold text-primary-strong">
                <LightbulbIcon className="size-4" aria-hidden />
                {hint}
              </span>
              {canSwitch && switchMonth && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={switchToSuggested}
                  className="bg-card"
                >
                  Pay {formatMonth(switchMonth).split(' ')[0]} instead
                </Button>
              )}
            </div>
          )}
          {monthRow && <MonthFacts row={monthRow} editing={mode === 'edit'} />}
        </div>
      )}

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-[0.9375rem] leading-none font-semibold">How they paid</legend>
        <ToggleGroup
          type="single"
          value={method}
          onValueChange={(v) => v && setMethod(v as PaymentMethod)}
          spacing={2}
          className="grid w-full grid-cols-3"
        >
          {METHODS.map(({ value, label, icon: Icon }) => (
            <ToggleGroupItem
              key={value}
              value={value}
              variant="outline"
              aria-label={label}
              className={cn(
                'h-12 w-full bg-card text-base',
                'data-[state=on]:border-primary data-[state=on]:bg-primary/25 data-[state=on]:text-foreground',
              )}
            >
              <Icon className="size-5" aria-hidden />
              {label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,13rem)_1fr]">
        <div className="grid content-start gap-2">
          <Label htmlFor="payment-paid-on">Paid on</Label>
          <Input
            id="payment-paid-on"
            type="date"
            value={paidOn}
            max={today()}
            onChange={(e) => {
              setPaidOn(e.target.value)
              setServerErrors((s) => ({ ...s, paidOn: undefined }))
            }}
            aria-invalid={Boolean(errors.paidOn) || undefined}
            aria-describedby={errorId('paidOn')}
          />
          <FieldError id={errorId('paidOn')} message={errors.paidOn} />
        </div>
        <div className="grid content-start gap-2">
          <Label htmlFor="payment-note">
            Note <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="payment-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. paid by grandmother"
            autoComplete="off"
          />
        </div>
      </div>

      <DialogFooter className="items-center sm:justify-between">
        <p className="hidden text-sm text-muted-foreground sm:block">
          Press <kbd className="rounded border bg-card px-1.5 py-0.5 font-sans text-xs">Enter</kbd>{' '}
          to save
        </p>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" size="lg" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" size="lg" disabled={saving} className="min-w-36 font-bold">
            {saving ? 'Saving…' : mode === 'edit' ? 'Save changes' : 'Save payment'}
          </Button>
        </div>
      </DialogFooter>
    </form>
  )
}

function FieldError({ id, message }: { id?: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} className="text-sm font-semibold text-owed">
      {message}
    </p>
  )
}

/** What's already recorded for the chosen month, e.g. "September: ₹500 of ₹1,500 paid". */
function MonthFacts({
  row,
  editing,
}: {
  row: { month: string; expected_paise: number; paid_paise: number; remaining_paise: number }
  editing: boolean
}) {
  const name = formatMonth(row.month).split(' ')[0]
  let text: ReactNode
  if (row.expected_paise === 0) {
    text = row.paid_paise > 0 ? `${formatRupees(row.paid_paise)} paid, no fee due.` : 'no fee due.'
  } else if (row.paid_paise === 0) {
    text = `${formatRupees(row.expected_paise)} due, nothing paid yet.`
  } else if (row.remaining_paise > 0) {
    text = `${formatRupees(row.paid_paise)} of ${formatRupees(row.expected_paise)} paid, ${formatRupees(row.remaining_paise)} left.`
  } else if (editing) {
    text = `${formatRupees(row.paid_paise)} paid of ${formatRupees(row.expected_paise)}.`
  } else {
    text = (
      <>
        <span className="font-semibold text-paid">already fully paid</span> (
        {formatRupees(row.paid_paise)}).
      </>
    )
  }
  return (
    <span className="text-muted-foreground">
      <span className="font-semibold text-foreground">{name}:</span> {text}
    </span>
  )
}
