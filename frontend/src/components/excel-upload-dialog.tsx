/**
 * Upload Excel (Students and Payments pages): choose a file, see exactly what adding it would do
 * row by row, make the few choices it needs, then Add. Nothing is saved until Add, nothing that
 * is already here is ever changed, and the server checks every row again (and saves a backup)
 * before adding anything.
 */
import { FileSpreadsheetIcon, FileUpIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'
import { useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { toast } from 'sonner'

import { useCommitImport, usePreviewImport, useStudents } from '@/api/queries'
import type {
  ExportTemplateKind,
  ImportPaymentDecision,
  ImportPaymentPreview,
  ImportPreview,
  ImportStudentPreview,
  StudentRead,
} from '@/api/types'
import { StatusPill } from '@/components/status'
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { templateUrl } from '@/lib/downloads'
import { errorMessage } from '@/lib/errors'
import { formatDate, formatMonthShort, formatRupees } from '@/lib/format'
import { METHOD_LABELS } from '@/lib/labels'
import type { Tone } from '@/lib/status'
import {
  addedSentence,
  emptyChoices,
  paymentKey,
  studentAdded,
  summarize,
  summarySentence,
  type Choices,
  type PaymentChoice,
  type Summary,
} from '@/lib/upload'
import { cn } from '@/lib/utils'

// ---- status words --------------------------------------------------------------------------------

const STUDENT_STATUS: Record<ImportStudentPreview['status'], { tone: Tone; label: string }> = {
  new: { tone: 'paid', label: 'New' },
  exists: { tone: 'muted', label: 'Already exists' },
  similar: { tone: 'partial', label: 'Looks similar' },
  problem: { tone: 'owed', label: 'Problem' },
}

const PAYMENT_STATUS: Record<ImportPaymentPreview['status'], { tone: Tone; label: string }> = {
  ready: { tone: 'paid', label: 'Will be added' },
  needs_student: { tone: 'partial', label: 'Needs a student' },
  follows_student: { tone: 'partial', label: 'Goes with its student' },
  unassigned: { tone: 'muted', label: 'Unassigned' },
  duplicate: { tone: 'muted', label: 'Already exists' },
  problem: { tone: 'owed', label: 'Problem' },
}

// ---- the dialog ----------------------------------------------------------------------------------

type Filter = 'all' | 'choose' | 'skipped'

export function ExcelUploadDialog({
  open,
  onOpenChange,
  kind,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Which page it was opened from: decides the words and the blank template. */
  kind: ExportTemplateKind
}) {
  const previewImport = usePreviewImport()
  const commitImport = useCommitImport()
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [choices, setChoices] = useState<Choices>(emptyChoices)
  const [filter, setFilter] = useState<Filter>('all')
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    setFile(null)
    setPreview(null)
    setChoices(emptyChoices())
    setFilter('all')
    setError(null)
    previewImport.reset()
    commitImport.reset()
  }

  const close = (next: boolean) => {
    if (!next && commitImport.isPending) return // adding: wait for it to finish
    onOpenChange(next)
    if (!next) reset()
  }

  const read = (chosen: File) => {
    setFile(chosen)
    setError(null)
    setPreview(null)
    setChoices(emptyChoices())
    previewImport.mutate(chosen, {
      onSuccess: setPreview,
      onError: (e) => setError(errorMessage(e, 'Couldn’t read this file. Please try again.')),
    })
  }

  const summary = useMemo(() => (preview ? summarize(preview, choices) : null), [preview, choices])

  const add = async () => {
    if (!preview || !summary) return
    try {
      const result = await commitImport.mutateAsync({
        filename: preview.filename,
        students: preview.students.flatMap((s) =>
          s.data
            ? [{ data: s.data, ...(choices.addStudents.has(s.row) ? { add: true } : {}) }]
            : [],
        ),
        payments: preview.payments.flatMap((p): ImportPaymentDecision[] => {
          if (!p.data) return []
          const choice = choices.payments.get(paymentKey(p))
          if (choice?.startsWith('student:')) {
            return [
              { data: p.data, choice: 'student' as const, student_id: Number(choice.slice(8)) },
            ]
          }
          if (choice === 'skip' || choice === 'unassigned') return [{ data: p.data, choice }]
          // What its status says; the server works that out again for itself.
          return [{ data: p.data, choice: 'auto' as const }]
        }),
      })
      const title = addedSentence(
        result.students_added,
        result.payments_added,
        result.unassigned_added,
      )
      const notes = [
        result.unassigned_added ? 'Unassigned payments wait at the top of the Payments page.' : '',
        result.backup_file ? 'A backup was saved first.' : '',
      ].filter(Boolean)
      toast.success(title, { description: notes.join(' ') || undefined })
      close(false)
    } catch (e) {
      toast.error(errorMessage(e, 'Nothing was added. Please try again.'))
    }
  }

  const words =
    kind === 'students'
      ? 'Add a list of students from an Excel file.'
      : 'Add payments from an Excel file, such as a list you kept before.'

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className={cn('max-h-[94vh] overflow-y-auto', preview ? 'sm:max-w-5xl' : 'sm:max-w-xl')}
      >
        <DialogHeader>
          <DialogTitle>Upload Excel</DialogTitle>
          <DialogDescription>
            {preview
              ? `From ${file?.name ?? 'your file'}. Nothing is saved until you click Add.`
              : `${words} You’ll see what will be added before anything is saved. Nothing already here is changed.`}
          </DialogDescription>
        </DialogHeader>

        {!preview ? (
          <PickFile
            kind={kind}
            reading={previewImport.isPending}
            fileName={file?.name}
            error={error}
            onFile={read}
          />
        ) : (
          <PreviewBody
            preview={preview}
            summary={summary!}
            choices={choices}
            setChoices={setChoices}
            filter={filter}
            setFilter={setFilter}
          />
        )}

        <DialogFooter>
          {preview && (
            <Button
              variant="ghost"
              onClick={reset}
              disabled={commitImport.isPending}
              className="mr-auto"
            >
              Choose another file
            </Button>
          )}
          <Button variant="outline" onClick={() => close(false)} disabled={commitImport.isPending}>
            Cancel
          </Button>
          {preview && summary && (
            <Button
              onClick={() => void add()}
              disabled={
                commitImport.isPending ||
                summary.students + summary.payments + summary.unassigned === 0
              }
            >
              {commitImport.isPending && <LoaderCircleIcon className="animate-spin" aria-hidden />}
              {commitImport.isPending
                ? 'Adding…'
                : summary.students + summary.payments + summary.unassigned === 0
                  ? 'Nothing to add'
                  : 'Add'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PickFile({
  kind,
  reading,
  fileName,
  error,
  onFile,
}: {
  kind: ExportTemplateKind
  reading: boolean
  fileName?: string
  error: string | null
  onFile: (file: File) => void
}) {
  const inputId = useId()
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    const dropped = event.dataTransfer.files[0]
    if (dropped) onFile(dropped)
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          'flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-border px-6 py-8 text-center transition-colors',
          dragging && 'border-primary bg-primary/10',
        )}
      >
        <FileSpreadsheetIcon className="size-10 text-primary-strong" aria-hidden />
        {reading ? (
          <p className="flex items-center gap-2 text-base font-semibold" role="status">
            <LoaderCircleIcon className="size-5 animate-spin" aria-hidden />
            Reading {fileName ?? 'the file'}…
          </p>
        ) : (
          <>
            <p className="text-base text-muted-foreground">Drag an Excel file (.xlsx) here, or</p>
            <input
              ref={input}
              id={inputId}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              aria-label="Excel file to upload"
              onChange={(e) => {
                const chosen = e.target.files?.[0]
                e.target.value = '' // the same file can be chosen again
                if (chosen) onFile(chosen)
              }}
            />
            <Button type="button" size="lg" onClick={() => input.current?.click()}>
              <FileUpIcon aria-hidden />
              Choose a file
            </Button>
          </>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border border-owed/25 bg-owed-soft px-4 py-3 text-base text-owed"
        >
          <TriangleAlertIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p>{error}</p>
        </div>
      )}

      <ul className="space-y-1.5 text-sm text-muted-foreground">
        <li>
          Starting a new list?{' '}
          <a
            href={templateUrl(kind)}
            download
            className="font-bold text-primary-strong underline-offset-4 hover:underline"
          >
            Download a blank template
          </a>
          , fill it in and upload it here.
        </li>
        <li>
          A file from <strong>Download Excel</strong> or <strong>Download everything</strong> works
          too: students and payments that are already here are skipped.
        </li>
      </ul>
    </div>
  )
}

function PreviewBody({
  preview,
  summary,
  choices,
  setChoices,
  filter,
  setFilter,
}: {
  preview: ImportPreview
  summary: Summary
  choices: Choices
  setChoices: (update: (c: Choices) => Choices) => void
  filter: Filter
  setFilter: (f: Filter) => void
}) {
  const { data: allStudents = [] } = useStudents('all')
  const names = useMemo(() => new Map(allStudents.map((s) => [s.id, s])), [allStudents])
  const studentByRow = useMemo(
    () => new Map(preview.students.map((s) => [s.row, s])),
    [preview.students],
  )

  const choosing = (status: string) => status === 'similar' || status === 'needs_student'
  const skipped = (status: string) =>
    status === 'exists' || status === 'duplicate' || status === 'problem'
  const keep = (status: string) =>
    filter === 'all' || (filter === 'choose' ? choosing(status) : skipped(status))
  const students = preview.students.filter((s) => keep(s.status))
  const payments = preview.payments.filter((p) => keep(p.status))
  const skippedCount = summary.alreadyHere + summary.problems

  const setPayment = (p: ImportPaymentPreview, choice: PaymentChoice) =>
    setChoices((c) => ({ ...c, payments: new Map(c.payments).set(paymentKey(p), choice) }))
  const setStudent = (row: number, add: boolean) =>
    setChoices((c) => {
      const next = new Set(c.addStudents)
      if (add) next.add(row)
      else next.delete(row)
      return { ...c, addStudents: next }
    })

  return (
    <div className="min-w-0 space-y-4">
      <p
        className="rounded-xl bg-muted/60 px-4 py-3 text-base font-semibold"
        role="status"
        data-testid="upload-summary"
      >
        {summarySentence(summary)}
      </p>
      {preview.ignored_sheets.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Not read (no student or payment headings found):{' '}
          {preview.ignored_sheets.map((s) => `“${s}”`).join(', ')}.
        </p>
      )}

      <Tabs value={filter} onValueChange={(v) => setFilter(v as Filter)}>
        <TabsList aria-label="Which rows to show">
          <TabsTrigger value="all">All rows</TabsTrigger>
          <TabsTrigger value="choose" disabled={summary.toChoose === 0}>
            To choose ({summary.toChoose})
          </TabsTrigger>
          <TabsTrigger value="skipped" disabled={skippedCount === 0}>
            Skipped ({skippedCount})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="max-h-[48vh] space-y-5 overflow-auto rounded-xl border border-border/80">
        {students.length > 0 && (
          <RowTable
            caption={`Students (${preview.students.length})`}
            headings={['Row', 'Name', 'Phone', 'Monthly fee', 'Joined', 'What happens']}
          >
            {students.map((s) => (
              <tr key={s.row} className="border-t border-border/60 align-top">
                <Cell className="text-muted-foreground tabular-nums">{s.row}</Cell>
                <Cell className="font-semibold">{s.name || '—'}</Cell>
                <Cell>{s.phone ?? '—'}</Cell>
                <Cell className="tabular-nums">
                  {s.monthly_fee_paise === null ? '—' : formatRupees(s.monthly_fee_paise)}
                </Cell>
                <Cell>{s.joined_month ? formatMonthShort(s.joined_month) : '—'}</Cell>
                <Cell className="min-w-64">
                  <StatusLine {...STUDENT_STATUS[s.status]} reason={s.reason} />
                  {s.status === 'similar' && (
                    <Select
                      value={choices.addStudents.has(s.row) ? 'add' : 'skip'}
                      onValueChange={(v) => setStudent(s.row, v === 'add')}
                    >
                      <SelectTrigger
                        className="mt-2 h-9 w-full bg-card"
                        aria-label={`What to do with ${s.name} (row ${s.row})`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="skip">Skip</SelectItem>
                        <SelectItem value="add">Add as new</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </Cell>
              </tr>
            ))}
          </RowTable>
        )}
        {payments.length > 0 && (
          <RowTable
            caption={`Payments (${preview.payments.length})`}
            headings={['Row', 'Student', 'Amount', 'Paid on', 'For month', 'What happens']}
          >
            {payments.map((p) => (
              <tr key={paymentKey(p)} className="border-t border-border/60 align-top">
                <Cell className="text-muted-foreground tabular-nums">
                  {p.sheet !== preview.payments[0]?.sheet ? `${p.sheet} ` : ''}
                  {p.row}
                </Cell>
                <Cell className="font-semibold">{p.student_text || '—'}</Cell>
                <Cell className="tabular-nums">
                  {p.amount_paise === null ? '—' : formatRupees(p.amount_paise)}
                  {p.method && (
                    <span className="block text-sm font-normal text-muted-foreground">
                      {METHOD_LABELS[p.method]}
                    </span>
                  )}
                </Cell>
                <Cell>{p.paid_on ? formatDate(p.paid_on) : '—'}</Cell>
                <Cell>{p.for_month ? formatMonthShort(p.for_month) : '—'}</Cell>
                <Cell className="min-w-72">
                  <PaymentWhatHappens
                    payment={p}
                    choice={choices.payments.get(paymentKey(p))}
                    onChoose={(c) => setPayment(p, c)}
                    names={names}
                    student={p.student_row !== null ? studentByRow.get(p.student_row) : undefined}
                    studentAdded={
                      p.student_row !== null &&
                      studentByRow.has(p.student_row) &&
                      studentAdded(studentByRow.get(p.student_row)!, choices)
                    }
                  />
                </Cell>
              </tr>
            ))}
          </RowTable>
        )}
        {students.length + payments.length === 0 && (
          <p className="px-4 py-6 text-center text-muted-foreground">No rows to show here.</p>
        )}
      </div>
    </div>
  )
}

function RowTable({
  caption,
  headings,
  children,
}: {
  caption: string
  headings: string[]
  children: ReactNode
}) {
  return (
    <table className="w-full text-left text-[0.9375rem]">
      <caption className="px-3 pt-3 pb-1 text-left text-base font-extrabold">{caption}</caption>
      <thead className="sticky top-0 z-10 bg-card text-sm text-muted-foreground">
        <tr>
          {headings.map((h) => (
            <th key={h} scope="col" className="px-3 py-2 font-semibold">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}

function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn('px-3 py-2', className)}>{children}</td>
}

function StatusLine({
  tone,
  label,
  reason,
  children,
}: {
  tone: Tone
  label: string
  reason?: string | null
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col items-start gap-1">
      <StatusPill tone={tone}>{label}</StatusPill>
      {reason && <p className="text-sm text-muted-foreground">{reason}</p>}
      {children}
    </div>
  )
}

function PaymentWhatHappens({
  payment: p,
  choice,
  onChoose,
  names,
  student,
  studentAdded,
}: {
  payment: ImportPaymentPreview
  choice: PaymentChoice | undefined
  onChoose: (choice: PaymentChoice) => void
  names: Map<number, StudentRead>
  student?: ImportStudentPreview
  studentAdded: boolean
}) {
  const status = PAYMENT_STATUS[p.status]
  if (p.status === 'ready') {
    const to =
      p.student_id !== null
        ? names.get(p.student_id)?.name
        : student
          ? `${student.name} (new, row ${student.row})`
          : undefined
    return <StatusLine {...status}>{to && <span className="text-sm">To {to}</span>}</StatusLine>
  }
  if (p.status === 'follows_student' && student) {
    return (
      <StatusLine {...status}>
        <span className="text-sm">
          {studentAdded
            ? `To ${student.name} (new, row ${student.row}), since you’re adding them`
            : `Kept as unassigned, unless you add ${student.name} (row ${student.row})`}
        </span>
      </StatusLine>
    )
  }
  if (p.status !== 'needs_student' && p.status !== 'unassigned') {
    return <StatusLine {...status} reason={p.reason} />
  }
  // Needs a student: keep it unassigned (default), skip it, or give it to someone.
  const current: PaymentChoice = choice ?? 'unassigned'
  const pickedId = current.startsWith('student:') ? Number(current.slice(8)) : null
  const candidates = p.candidate_ids.map((id) => names.get(id)).filter(Boolean) as StudentRead[]
  const showPicker =
    current === 'pick' || (pickedId !== null && !p.candidate_ids.includes(pickedId))
  return (
    <StatusLine {...status} reason={p.status === 'needs_student' ? p.reason : null}>
      <Select
        value={showPicker ? 'pick' : current}
        onValueChange={(v) => onChoose(v as PaymentChoice)}
      >
        <SelectTrigger
          className="mt-1 h-9 w-full bg-card"
          aria-label={`Who paid row ${p.row} (${p.student_text})`}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unassigned">Keep as unassigned</SelectItem>
          <SelectItem value="skip">Skip</SelectItem>
          {candidates.length > 0 && (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Give it to</SelectLabel>
                {candidates.map((s) => (
                  <SelectItem key={s.id} value={`student:${s.id}`}>
                    {s.name}
                    {s.phone ? ` · ${s.phone}` : ''}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          )}
          <SelectSeparator />
          <SelectItem value="pick">Another student…</SelectItem>
        </SelectContent>
      </Select>
      {showPicker && (
        <div className="mt-1 w-full">
          <StudentCombobox
            label={`Student for row ${p.row}`}
            value={pickedId}
            onChange={(id) => onChoose(id ? `student:${id}` : 'pick')}
            placeholder="Choose a student"
            className="h-10"
          />
        </div>
      )}
    </StatusLine>
  )
}
