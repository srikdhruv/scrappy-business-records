/**
 * Upload Excel (Students and Payments pages): choose a file, see exactly what adding it would do
 * row by row, make the few choices it needs, then Add. Nothing is saved until Add, nothing that
 * is already here is ever changed, and the server checks every row again (and saves a backup)
 * before adding anything.
 *
 * Batches: a file's Batches sheet adds its batches; a name in the students' Batch column that
 * isn't a batch here is flagged, and only created if she ticks "Create it" (otherwise those
 * students are left without a batch, the name kept as their old class label).
 */
import { FileSpreadsheetIcon, FileUpIcon, LoaderCircleIcon, TriangleAlertIcon } from 'lucide-react'
import { useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { toast } from 'sonner'

import { useCommitImport, usePreviewImport, useStudents, type ChosenFile } from '@/api/queries'
import type {
  ExportTemplateKind,
  ImportBatchPreview,
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
import { METHOD_LABELS, plural } from '@/lib/labels'
import type { Tone } from '@/lib/status'
import {
  addedSentence,
  batchesToCreate,
  emptyChoices,
  needsChoice,
  paymentKey,
  rowCount,
  toBase64,
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
  possible_duplicate: { tone: 'partial', label: 'Possible duplicate' },
  problem: { tone: 'owed', label: 'Problem' },
}

const BATCH_STATUS: Record<ImportBatchPreview['status'], { tone: Tone; label: string }> = {
  new: { tone: 'paid', label: 'Will be added' },
  exists: { tone: 'muted', label: 'Already here' },
  not_found: { tone: 'partial', label: 'Not found' },
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
  // The file as it was previewed: Add sends these bytes (and the preview's fingerprint of
  // them), so it can only ever add the file she saw, even if it changes on disk meanwhile.
  const [file, setFile] = useState<ChosenFile | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [choices, setChoices] = useState<Choices>(emptyChoices)
  const [filter, setFilter] = useState<Filter>('all')
  const [error, setError] = useState<string | null>(null)
  // Not-found batches she chose to create (by name, as in the preview).
  const [createBatches, setCreateBatches] = useState<ReadonlySet<string>>(new Set())

  const reset = () => {
    setFile(null)
    setPreview(null)
    setChoices(emptyChoices())
    setCreateBatches(new Set())
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

  const read = async (chosen: File) => {
    setError(null)
    setPreview(null)
    setChoices(emptyChoices())
    setCreateBatches(new Set())
    let picked: ChosenFile
    try {
      picked = { name: chosen.name, bytes: await chosen.arrayBuffer() }
    } catch {
      setError('Couldn’t open this file. Please choose it again.')
      return
    }
    setFile(picked)
    previewImport.mutate(picked, {
      onSuccess: setPreview,
      onError: (e) => setError(errorMessage(e, 'Couldn’t read this file. Please try again.')),
    })
  }

  const summary = useMemo(() => (preview ? summarize(preview, choices) : null), [preview, choices])

  const add = async () => {
    if (!preview || !summary) return
    try {
      // The file goes again, with only the choices she made: the server reads it and checks
      // every row once more, so nothing from the preview is taken on trust.
      const result = await commitImport.mutateAsync({
        file: toBase64(file!.bytes),
        file_sha256: preview.file_sha256,
        filename: preview.filename,
        students: [...choices.students].map(([row, add]) => ({ row, add })),
        payments: preview.payments.flatMap((p): ImportPaymentDecision[] => {
          const choice = choices.payments.get(paymentKey(p))
          const where = { sheet: p.sheet, row: p.row }
          if (choice?.startsWith('student:')) {
            return [{ ...where, choice: 'student', student_id: Number(choice.slice(8)) }]
          }
          if (choice === 'skip' || choice === 'unassigned' || choice === 'add') {
            return [{ ...where, choice }]
          }
          return [] // what its status says
        }),
        create_batches: [...createBatches],
      })
      let title = addedSentence(
        result.students_added,
        result.payments_added,
        result.unassigned_added,
      )
      const batches = plural(result.batches_added, 'batch', 'batches')
      if (result.batches_added > 0 && title === 'Nothing was added') title = `Added ${batches}`
      const notes = [
        result.batches_added > 0 && !title.endsWith(batches) ? `${batches} created.` : '',
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
            onFile={(chosen) => void read(chosen)}
          />
        ) : (
          <PreviewBody
            preview={preview}
            summary={summary!}
            choices={choices}
            setChoices={setChoices}
            filter={filter}
            setFilter={setFilter}
            createBatches={createBatches}
            setCreateBatches={setCreateBatches}
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
          {preview &&
            summary &&
            (() => {
              const nothing =
                summary.students +
                  summary.payments +
                  summary.unassigned +
                  batchesToCreate(preview, createBatches) ===
                0
              return (
                <Button onClick={() => void add()} disabled={commitImport.isPending || nothing}>
                  {commitImport.isPending && (
                    <LoaderCircleIcon className="animate-spin" aria-hidden />
                  )}
                  {commitImport.isPending ? 'Adding…' : nothing ? 'Nothing to add' : 'Add'}
                </Button>
              )
            })()}
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
  createBatches,
  setCreateBatches,
}: {
  preview: ImportPreview
  summary: Summary
  choices: Choices
  setChoices: (update: (c: Choices) => Choices) => void
  filter: Filter
  setFilter: (f: Filter) => void
  createBatches: ReadonlySet<string>
  setCreateBatches: (create: ReadonlySet<string>) => void
}) {
  const { data: allStudents = [] } = useStudents('all')
  const names = useMemo(() => new Map(allStudents.map((s) => [s.id, s])), [allStudents])
  const studentByRow = useMemo(
    () => new Map(preview.students.map((s) => [s.row, s])),
    [preview.students],
  )

  const skipped = (status: string) =>
    status === 'exists' || status === 'duplicate' || status === 'problem'
  const keep = (row: { status: string }) =>
    filter === 'all' || (filter === 'choose' ? needsChoice(row) : skipped(row.status))
  const students = preview.students.filter(keep)
  const withBatch = preview.students.some((s) => s.batch_name)
  const payments = preview.payments.filter(keep)
  const skippedCount = summary.alreadyHere + summary.problems
  const studentTotal = rowCount(preview.student_counts)
  const paymentTotal = rowCount(preview.payment_counts)

  const setPayment = (p: ImportPaymentPreview, choice: PaymentChoice) =>
    setChoices((c) => ({ ...c, payments: new Map(c.payments).set(paymentKey(p), choice) }))
  const setStudent = (row: number, add: boolean) =>
    setChoices((c) => ({ ...c, students: new Map(c.students).set(row, add) }))

  return (
    <div className="min-w-0 space-y-4">
      <p
        className="rounded-xl bg-muted/60 px-4 py-3 text-base font-semibold"
        role="status"
        data-testid="upload-summary"
      >
        {summarySentence(summary)}
      </p>
      {preview.hidden_sheets.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Hidden sheets, not read: {preview.hidden_sheets.map((s) => `“${s}”`).join(', ')}. To add
          them, show them in Excel first.
        </p>
      )}
      {preview.ignored_sheets.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Not read (no student or payment headings found):{' '}
          {preview.ignored_sheets.map((s) => `“${s}”`).join(', ')}.
        </p>
      )}

      {(preview.batches ?? []).length > 0 && (
        <BatchesSection
          batches={preview.batches ?? []}
          create={createBatches}
          onCreate={(name, yes) => {
            const next = new Set(createBatches)
            if (yes) next.add(name)
            else next.delete(name)
            setCreateBatches(next)
          }}
        />
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
            caption={`Students (${studentTotal.toLocaleString('en-IN')})`}
            more={preview.all_rows_shown ? 0 : studentTotal - preview.students.length}
            headings={[
              'Row',
              'Name',
              'Phone',
              ...(withBatch ? ['Batch'] : []),
              'Monthly fee',
              'Joined',
              'What happens',
            ]}
          >
            {students.map((s) => (
              <tr key={s.row} className="border-t border-border/60 align-top">
                <Cell className="text-muted-foreground tabular-nums">{s.row}</Cell>
                <Cell className="font-semibold">{s.name || '—'}</Cell>
                <Cell>{s.phone ?? '—'}</Cell>
                {withBatch && <Cell>{s.batch_name ?? '—'}</Cell>}
                <Cell className="tabular-nums">
                  {s.monthly_fee_paise === null ? '—' : formatRupees(s.monthly_fee_paise)}
                </Cell>
                <Cell>{s.joined_month ? formatMonthShort(s.joined_month) : '—'}</Cell>
                <Cell className="min-w-64">
                  <StatusLine {...STUDENT_STATUS[s.status]} reason={s.reason} />
                  {s.status === 'similar' && (
                    <Select
                      value={studentAdded(s, choices) ? 'add' : 'skip'}
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
            caption={`Payments (${paymentTotal.toLocaleString('en-IN')})`}
            more={preview.all_rows_shown ? 0 : paymentTotal - preview.payments.length}
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
  more,
  children,
}: {
  caption: string
  headings: string[]
  /** Rows not listed (a long file): they need no choice, and the summary counts them. */
  more: number
  children: ReactNode
}) {
  return (
    <table className="w-full text-left text-[0.9375rem]">
      {more > 0 && (
        <tfoot>
          <tr>
            <td colSpan={headings.length} className="px-3 py-3 text-sm text-muted-foreground">
              …and {more.toLocaleString('en-IN')} more rows that need nothing from you, not listed
              here. The summary above counts them all.
            </td>
          </tr>
        </tfoot>
      )}
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
  if (p.status === 'duplicate' || p.status === 'possible_duplicate') {
    return (
      <StatusLine {...status} reason={p.reason}>
        <Select
          value={choice === 'add' ? 'add' : 'skip'}
          onValueChange={(v) => onChoose(v as PaymentChoice)}
        >
          <SelectTrigger
            className="mt-1 h-9 w-full bg-card"
            aria-label={`What to do with row ${p.row} (${p.student_text})`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="skip">Skip</SelectItem>
            <SelectItem value="add">Add anyway</SelectItem>
          </SelectContent>
        </Select>
      </StatusLine>
    )
  }
  if (p.status !== 'needs_student') {
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

/** The batches the file names: added (its Batches sheet), already here, or not found (with
 * "Create it"), and any Batches sheet row that can't be added. */
function BatchesSection({
  batches,
  create,
  onCreate,
}: {
  batches: ImportBatchPreview[]
  create: ReadonlySet<string>
  onCreate: (name: string, create: boolean) => void
}) {
  return (
    <section aria-labelledby="upload-batches" className="rounded-xl border border-border/80">
      <h3 id="upload-batches" className="px-4 pt-3 text-base font-extrabold">
        Batches ({batches.length})
      </h3>
      <ul className="divide-y divide-border/60">
        {batches.map((b) => (
          <li
            key={`${b.status}:${b.row ?? ''}:${b.name}`}
            className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-4 py-2.5"
          >
            <div className="min-w-0">
              <p className="font-semibold wrap-break-word">{b.name}</p>
              <p className="text-sm text-muted-foreground">
                {b.student_count > 0 && `${plural(b.student_count, 'student')} to add`}
                {b.row !== null && `${b.student_count > 0 ? ' · ' : ''}Batches sheet, row ${b.row}`}
              </p>
            </div>
            <div className="max-w-md min-w-64">
              <StatusLine
                {...BATCH_STATUS[b.status]}
                reason={
                  b.status === 'new'
                    ? 'From the file’s Batches sheet, with its days, times and fee.'
                    : b.status === 'exists'
                      ? 'Its students go into it. The batch itself isn’t changed.'
                      : b.status === 'not_found'
                        ? create.has(b.name)
                          ? 'It will be created (just the name), and its students go into it.'
                          : `${b.reason ?? 'Batch not found, will be left without a batch'} (the name is kept in their old class label, next to any label the row already has).`
                        : b.reason
                }
              />
              {b.status === 'not_found' && b.student_count === 0 && (
                <p className="mt-1.5 text-sm text-muted-foreground">
                  No student being added goes in it, so it can’t be created from this file.
                </p>
              )}
              {b.status === 'not_found' && b.student_count > 0 && (
                <label className="mt-1.5 flex items-center gap-2 text-sm font-semibold">
                  <input
                    type="checkbox"
                    className="size-4 accent-current"
                    checked={create.has(b.name)}
                    onChange={(e) => onCreate(b.name, e.target.checked)}
                  />
                  Create it
                </label>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
