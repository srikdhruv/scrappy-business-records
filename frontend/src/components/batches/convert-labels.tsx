/**
 * "Create batches from existing labels": the "Class or batch" text typed before batches existed
 * becomes batches, and each student goes into theirs. It shows exactly what will happen first
 * ("5 batches from 42 students: …") and does nothing until confirmed. Then it takes a backup and
 * does it all at once. The labels themselves are kept as they were typed.
 */
import { SparklesIcon, TagsIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

import { useConvertLabels, useLabelPreview } from '@/api/queries'
import type { LabelPreview } from '@/api/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { previewSentence } from '@/lib/batches'
import { errorMessage } from '@/lib/errors'
import { plural } from '@/lib/labels'

/** The button that opens it; shown only while some students have a label and no batch. */
export function ConvertLabelsButton({ className }: { className?: string }) {
  const { data: preview } = useLabelPreview()
  const [open, setOpen] = useState(false)
  if (!preview || preview.student_count === 0) return null
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} className={className}>
        <TagsIcon className="text-primary-strong" aria-hidden />
        Create batches from existing labels
      </Button>
      <ConvertLabelsDialog open={open} onOpenChange={setOpen} preview={preview} />
    </>
  )
}

export function ConvertLabelsDialog({
  open,
  onOpenChange,
  preview,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  preview: LabelPreview
}) {
  const convert = useConvertLabels()
  const run = async () => {
    try {
      const result = await convert.mutateAsync()
      toast.success(
        result.batches_created > 0
          ? `${plural(result.batches_created, 'batch', 'batches')} created`
          : 'Students placed in their batches',
        {
          description: `${plural(result.students_placed, 'student')} placed. A backup was saved first.`,
        },
      )
      onOpenChange(false)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => !convert.isPending && onOpenChange(next)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create batches from existing labels</DialogTitle>
          <DialogDescription>
            {previewSentence(preview)}. Labels that differ only in capitals or spaces go together.
            Nothing changes until you click the button.
          </DialogDescription>
        </DialogHeader>
        <ul className="grid gap-2" aria-label="Batches to create">
          {preview.groups.map((g) => (
            <li key={g.name} className="rounded-xl border border-border/80 bg-card px-4 py-3">
              <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="font-extrabold wrap-break-word">{g.name}</span>
                <span className="text-sm text-muted-foreground">
                  {plural(g.student_count, 'student')}
                  {g.existing_batch_id !== null && ' · into the batch you already have'}
                </span>
              </p>
              {g.labels.length > 1 && (
                <p className="text-sm text-muted-foreground">
                  Also written as: {g.labels.slice(1).join(' · ')}
                </p>
              )}
              <p className="mt-1 text-sm wrap-break-word">
                {g.student_names
                  .map((n) => (g.left_student_names.includes(n) ? `${n} (left)` : n))
                  .join(', ')}
              </p>
              {g.active_student_count === 0 && (
                <p className="mt-1 text-sm font-semibold text-partial">
                  Everyone in it has left: this batch would have nobody coming now.
                </p>
              )}
            </li>
          ))}
        </ul>
        <p className="flex items-start gap-2 text-base text-muted-foreground">
          <SparklesIcon className="mt-1 size-4 shrink-0 text-primary-strong" aria-hidden />
          <span>
            A backup is saved first. Each student’s label is kept as it was, and no fee or payment
            changes. Add days, times and the usual fee to each batch afterwards, with Edit.
          </span>
        </p>
        <DialogFooter>
          <Button
            variant="outline"
            size="lg"
            onClick={() => onOpenChange(false)}
            disabled={convert.isPending}
          >
            Cancel
          </Button>
          <Button size="lg" className="font-bold" onClick={run} disabled={convert.isPending}>
            {convert.isPending
              ? 'Creating…'
              : preview.new_batch_count > 0
                ? `Create ${plural(preview.new_batch_count, 'batch', 'batches')}`
                : `Place ${plural(preview.student_count, 'student')}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
