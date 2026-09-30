/**
 * "Are you sure?" for anything that can't be undone. It says exactly what will happen, and stays
 * open (with the button showing progress) until the action has finished.
 */
import { TriangleAlertIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { errorMessage } from '@/lib/errors'

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pendingLabel = 'Deleting…',
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description: ReactNode
  confirmLabel: string
  /** What the button says while the action runs. */
  pendingLabel?: string
  /** Runs the action. The dialog closes when it resolves, and shows a toast if it throws. */
  onConfirm: () => Promise<unknown>
}) {
  const [pending, setPending] = useState(false)

  const confirm = async () => {
    setPending(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia className="bg-owed-soft text-owed">
            <TriangleAlertIcon />
          </AlertDialogMedia>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">{description}</div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel size="lg" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <Button variant="destructive" size="lg" onClick={confirm} disabled={pending}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
