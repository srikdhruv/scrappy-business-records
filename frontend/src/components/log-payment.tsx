/**
 * The app-wide "+ Log payment" form (PRD: visible on every page; D5: one click from the
 * dashboard). Anything can open it, optionally prefilled:
 *
 *   const { openLogPayment, openEditPayment } = useLogPayment()
 *   openLogPayment({ studentId: 3, forMonth: '2026-10', amountPaise: 150000 })
 *   openEditPayment(payment)
 *
 * The dialog is rendered once, inside <LogPaymentProvider>.
 *
 * As the amount is typed, it previews where money above the month's fee will go (PRD ledger
 * rule 10: "₹1,500 extra will cover August 2026 (unpaid)"), worked out from the student's
 * payments with `lib/allocation.ts`. It never stops a save.
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
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'

import {
  useCreatePayment,
  useDeletePayment,
  useStudent,
  useStudentPayments,
  useSuggestedPayment,
  useUpdatePayment,
} from '@/api/queries'
import type { CreditSource, PaymentMethod, PaymentRead } from '@/api/types'
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
import { allocate, expectedFrom, monthShare, previewPayment } from '@/lib/allocation'
import { amountProblem } from '@/lib/amount'
import { creditSourceText, paymentUseText, previewText } from '@/lib/credit'
import {
  addMonths,
  formatDate,
  formatMonth,
  formatRupees,
  MONTHS_AHEAD,
  paiseToRupeesInput,
  rupeesToPaise,
  today,
} from '@/lib/format'
import { cn } from '@/lib/utils'

export interface LogPaymentPrefill {
  studentId?: number
  forMonth?: string
  amountPaise?: number
  /**
   * The id of an element to focus after a save, e.g. the dashboard's "Yet to pay" heading:
   * the button that opened the form may be gone by then (the row disappears once paid).
   */
  focusAfterSave?: string
}

interface LogPaymentContextValue {
  openLogPayment: (prefill?: LogPaymentPrefill) => void
  openEditPayment: (payment: PaymentRead) => void
}

type DialogState =
  | { open: false; key: number; focusId?: string }
  | { open: true; key: number; mode: 'create'; prefill: LogPaymentPrefill }
  | { open: true; key: number; mode: 'edit'; payment: PaymentRead }

const LogPaymentContext = createContext<LogPaymentContextValue | null>(null)

export function LogPaymentProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>({ open: false, key: 0 })
  // Undo runs here, not in the form: the form is gone by the time someone clicks Undo.
  const { mutateAsync: deletePayment } = useDeletePayment()
  const undo = useCallback(
    (paymentId: number) => {
      deletePayment(paymentId).then(
        () => toast('Payment removed'),
        (error: unknown) => toast.error(errorMessage(error)),
      )
    },
    [deletePayment],
  )

  const openLogPayment = useCallback((prefill: LogPaymentPrefill = {}) => {
    setState((s) => ({ open: true, key: s.key + 1, mode: 'create', prefill }))
  }, [])
  const openEditPayment = useCallback((payment: PaymentRead) => {
    setState((s) => ({ open: true, key: s.key + 1, mode: 'edit', payment }))
  }, [])
  const close = useCallback(
    (focusId?: string) => setState((s) => ({ open: false, key: s.key, focusId })),
    [],
  )

  // After a save, the button that opened the form may be gone (a paid row leaves "Yet to pay"),
  // so focus moves to the place the caller named instead of getting lost.
  const focusId = state.open ? undefined : state.focusId
  useEffect(() => {
    if (!focusId) return
    const timer = setTimeout(() => document.getElementById(focusId)?.focus())
    return () => clearTimeout(timer)
  }, [focusId, state.key])

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
              onDone={(didSave) =>
                close(didSave && state.mode === 'create' ? state.prefill.focusAfterSave : undefined)
              }
              onUndo={undo}
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

/** Amounts this many times the month's fee get a gentle "is this right?" (never blocking). */
const LARGE_AMOUNT_FACTOR = 3

/** Sorts a payment being logged after every saved one (they're handed out by date, then id). */
const NEW_PAYMENT_ID = Number.MAX_SAFE_INTEGER

function validate(values: {
  studentId: number | null
  amount: string
  paidOn: string
  forMonth: string | null
}): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {}
  if (values.studentId === null) errors.student = 'Choose who paid.'
  const amount = amountProblem(values.amount)
  if (amount) errors.amount = amount
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
  onUndo,
}: {
  mode: 'create' | 'edit'
  prefill?: LogPaymentPrefill
  payment?: PaymentRead
  onDone: (saved?: boolean) => void
  /** Deletes a just-saved payment. Lives in the provider, which outlives this form. */
  onUndo: (paymentId: number) => void
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
  const studentPayments = useStudentPayments(studentId ?? undefined)

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
  const saving = createPayment.isPending || updatePayment.isPending
  // Also blocks a second save that starts before `saving` has re-rendered (a held-down Enter).
  const savingNow = useRef(false)

  const clientErrors = validate({ studentId, amount, paidOn, forMonth })
  const errors: Partial<Record<Field, string>> = submitted
    ? { ...serverErrors, ...clientErrors }
    : serverErrors
  const errorId = (field: Field) => (errors[field] ? `payment-${field}-error` : undefined)

  const pickStudent = (id: number | null) => {
    setStudentId(id)
    setServerErrors((e) => ({ ...e, student: undefined }))
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    void save(method)
  }

  // Enter on a method button (UPI, Cash, Other) saves too, with that method: after clicking
  // Cash, the focus is on it, and Enter should still save. Arrow keys still move between them.
  const onMethodKeyDown = (event: KeyboardEvent<HTMLButtonElement>, value: PaymentMethod) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault() // not a click: that would toggle the button instead
    setMethod(value)
    void save(value)
  }

  const save = async (chosenMethod: PaymentMethod) => {
    setSubmitted(true)
    setFormError(null)
    if (Object.keys(clientErrors).length > 0 || saving || savingNow.current) return
    savingNow.current = true
    const body = {
      student_id: studentId!,
      amount_paise: rupeesToPaise(amount)!,
      paid_on: paidOn,
      for_month: forMonth!,
      method: chosenMethod,
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
          duration: 10_000, // time to notice a slip and click Undo
          action: { label: 'Undo', onClick: () => onUndo(created.id) },
        })
      }
      onDone(true)
    } catch (error) {
      const byField: Partial<Record<Field, string>> = {}
      for (const [key, msg] of Object.entries(fieldErrors(error))) {
        const field = SERVER_FIELDS[key]
        if (field) byField[field] = msg
      }
      setServerErrors(byField)
      if (Object.keys(byField).length === 0) setFormError(errorMessage(error))
    } finally {
      savingNow.current = false
    }
  }

  const info = student.data
  // The server's month: "now" for every hint here comes from it, never from this laptop's clock.
  const now = info?.current_month
  const monthRow = info?.months.find((m) => m.month === forMonth)
  const suggested = mode === 'create' && !suggestion.isFetching ? suggestion.data : undefined
  const hint = (() => {
    if (!suggested) return null
    const m = suggested.for_month
    if (suggested.reason === 'all_paid' || m === null) {
      return 'All paid up. Nothing is owed right now.'
    }
    if (suggested.reason === 'next_unpaid') {
      return forMonth === m ? `All paid up. Next due: ${formatMonth(m)}` : null
    }
    // reason "owed": the oldest month still owed.
    if (forMonth === m) {
      return m === now ? `Due now: ${formatMonth(m)}` : `Oldest unpaid: ${formatMonth(m)}`
    }
    // Opened for a later month while an older one is still owed: point it out.
    return forMonth !== null && m < forMonth ? `Oldest unpaid: ${formatMonth(m)}` : null
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

  // Months that make sense for this student: from joining, to leaving (or two years ahead).
  const latest = now ? addMonths(now, MONTHS_AHEAD) : undefined
  const monthMin = info?.joined_month ?? '2000-01'
  const monthMax = info?.left_month && latest && info.left_month < latest ? info.left_month : latest

  // A gentle check for a slipped zero: far more than that month's fee.
  const amountPaise = rupeesToPaise(amount)
  const fee = monthRow?.expected_paise ?? info?.monthly_fee_paise ?? 0
  const looksLarge =
    amountPaise !== null && fee > 0 && amountPaise >= fee * LARGE_AMOUNT_FACTOR && !errors.amount

  // The month as it stands without this payment (when editing, without the payment being
  // edited), and where money above its fee would go. Worked out from the student's payments;
  // until they load, a new payment's month comes from the server's month row.
  const ofThisStudent = studentPayments.data?.every((p) => p.student_id === studentId)
  const worked = (() => {
    if (!info || info.id !== studentId || !forMonth || !studentPayments.data || !ofThisStudent) {
      return null
    }
    const others = studentPayments.data.filter((p) => p.id !== payment?.id)
    const expected = expectedFrom(info, info.fee_history)
    const share = monthShare(allocate(others, info, expected, info.current_month), forMonth)
    const logged = others
      .filter((p) => p.for_month === forMonth)
      .reduce((sum, p) => sum + p.amount_paise, 0)
    const facts = factsFrom({
      month: forMonth,
      expected_paise: expected(forMonth),
      paid_paise: logged,
      ...share,
    })
    const preview =
      amountPaise !== null && !errors.amount
        ? previewPayment({
            others,
            draft: {
              id: payment?.id ?? NEW_PAYMENT_ID,
              for_month: forMonth,
              amount_paise: amountPaise,
              paid_on: /^\d{4}-\d{2}-\d{2}$/.test(paidOn) ? paidOn : today(),
            },
            student: info,
            expected,
            now: info.current_month,
          })
        : null
    return { facts, preview, excluding: others.length < studentPayments.data.length }
  })()
  const factsRow =
    worked?.facts ?? (mode === 'create' && monthRow ? factsFrom(monthRow) : undefined)
  const extraText = worked?.preview ? previewText(worked.preview) : null
  // What an unchanged payment does now, as the Payments page says it.
  const savedUse = mode === 'edit' && payment ? paymentUseText(payment) : null

  const prefilledStudent = mode === 'edit' || prefill?.studentId !== undefined

  return (
    <form onSubmit={onSubmit} noValidate className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{mode === 'edit' ? 'Edit payment' : 'Log a payment'}</DialogTitle>
        <DialogDescription>
          {mode === 'edit'
            ? 'Fix any detail and save.'
            : 'Record money you’ve received from a student.'}
        </DialogDescription>
        {savedUse && <p className="text-sm font-bold text-credit">Now: {savedUse}.</p>}
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
          label="Student"
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
              // The student is already known: start on the amount, so Enter saves.
              autoFocus={prefilledStudent}
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value)
                setAmountEdited(true)
                setServerErrors((s) => ({ ...s, amount: undefined }))
              }}
              aria-invalid={Boolean(errors.amount) || undefined}
              aria-describedby={
                errorId('amount') ?? (looksLarge || extraText ? 'payment-amount-check' : undefined)
              }
              className="h-12 pl-8 text-xl font-bold tabular-nums"
            />
          </div>
          <FieldError id={errorId('amount')} message={errors.amount} />
        </div>
        <div className="grid content-start gap-2">
          <Label htmlFor="payment-month">For month</Label>
          <MonthPicker
            id="payment-month"
            label="For month"
            current={now}
            value={forMonth}
            onChange={(m) => {
              setForMonth(m)
              setMonthEdited(true)
              setServerErrors((s) => ({ ...s, forMonth: undefined }))
            }}
            min={monthMin}
            max={monthMax}
            hint={
              info
                ? `Months before ${formatMonth(info.joined_month)}${info.left_month ? ` or after ${formatMonth(info.left_month)}` : ''} are greyed out. Change their Joined month with Edit on their profile.`
                : undefined
            }
            invalid={Boolean(errors.forMonth)}
            aria-describedby={errorId('forMonth') ?? (hint ? 'payment-month-hint' : undefined)}
            className="h-12"
          />
          <FieldError id={errorId('forMonth')} message={errors.forMonth} />
        </div>
      </div>

      {/* A slipped zero, and where money above the month's fee will go: never blocking. */}
      {(looksLarge || extraText) && (
        <p
          id="payment-amount-check"
          className="-mt-2 rounded-xl bg-credit-soft/70 px-4 py-2.5 text-base font-semibold text-credit"
          aria-live="polite"
        >
          {looksLarge && (
            <span className="text-partial">
              That’s much more than the {formatRupees(fee)} fee. Is it right?{' '}
            </span>
          )}
          {extraText &&
            (looksLarge
              ? `If so, ${extraText.charAt(0).toLowerCase()}${extraText.slice(1)}`
              : extraText)}
        </p>
      )}

      {(hint || factsRow) && (
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
          {factsRow && (
            <MonthFacts
              row={factsRow}
              joined={info?.joined_month}
              left={info?.left_month ?? undefined}
              excludingThis={mode === 'edit' && Boolean(worked?.excluding)}
              editing={mode === 'edit'}
            />
          )}
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
              onKeyDown={(event) => onMethodKeyDown(event, value)}
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
            aria-describedby={errorId('paidOn') ?? 'payment-paid-on-text'}
          />
          {/* The date box follows the laptop's settings; this spells it out unambiguously. */}
          {!errors.paidOn && /^\d{4}-\d{2}-\d{2}$/.test(paidOn) && (
            <p id="payment-paid-on-text" className="text-sm text-muted-foreground">
              {paidOn === today() ? `Today, ${formatDate(paidOn)}` : formatDate(paidOn)}
            </p>
          )}
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
          <Button type="button" variant="outline" size="lg" onClick={() => onDone()}>
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

interface FactsRow {
  month: string
  expected_paise: number
  /** What pays the month: its own payments (up to the fee) and credit from other payments.
   * For a month with no fee: what was logged for it. */
  paid_paise: number
  remaining_paise: number
  credit_sources: CreditSource[]
}

function factsFrom(m: {
  month: string
  expected_paise: number
  paid_paise: number
  paid_direct_paise: number
  covered_by_credit_paise: number
  credit_sources: CreditSource[]
}): FactsRow {
  const counted = m.paid_direct_paise + m.covered_by_credit_paise
  return {
    month: m.month,
    expected_paise: m.expected_paise,
    paid_paise: m.expected_paise > 0 ? counted : m.paid_paise,
    remaining_paise: Math.max(0, m.expected_paise - counted),
    credit_sources: m.credit_sources,
  }
}

/** What's already recorded for the chosen month, e.g. "September: ₹500 of ₹1,500 paid". */
function MonthFacts({
  row,
  joined,
  left,
  editing,
  excludingThis,
}: {
  row: FactsRow
  joined?: string
  left?: string
  editing: boolean
  excludingThis: boolean
}) {
  const name = formatMonth(row.month).split(' ')[0]
  const others = excludingThis ? ' by other payments' : ''
  let text: ReactNode
  if (row.expected_paise === 0) {
    const why =
      joined && row.month < joined
        ? 'before they joined, so no fee is due'
        : left && row.month > left
          ? 'after they left, so no fee is due'
          : 'no fee due'
    text = row.paid_paise > 0 ? `${formatRupees(row.paid_paise)} paid${others}, ${why}.` : `${why}.`
  } else if (row.paid_paise === 0) {
    text = excludingThis
      ? `${formatRupees(row.expected_paise)} fee, nothing else paid.`
      : `${formatRupees(row.expected_paise)} due, nothing paid yet.`
  } else if (row.remaining_paise > 0) {
    text = `${formatRupees(row.paid_paise)} of ${formatRupees(row.expected_paise)} paid${others}, ${formatRupees(row.remaining_paise)} left.`
  } else if (editing) {
    text = `${formatRupees(row.paid_paise)} of ${formatRupees(row.expected_paise)} paid${others}.`
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
      {row.credit_sources.length > 0 && (
        <span className="block text-sm font-semibold text-credit">
          Includes {row.credit_sources.map((c) => creditSourceText(c)).join(', ')}.
        </span>
      )}
    </span>
  )
}
