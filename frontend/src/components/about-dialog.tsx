/** Settings → About: the version and build, and where the records, backups and logs live. */
import { useAbout } from '@/api/queries'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { errorMessage } from '@/lib/errors'
import { plural } from '@/lib/labels'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-sm font-semibold text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-base break-words">{children}</dd>
    </div>
  )
}

export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const about = useAbout(open)
  const data = about.data
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>About Scrappy Records</DialogTitle>
          <DialogDescription>
            Which version this is, and where your records are kept.
          </DialogDescription>
        </DialogHeader>
        {about.isError ? (
          <p role="alert" className="text-owed">
            {errorMessage(about.error)}
          </p>
        ) : !data ? (
          <div className="grid gap-3">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-5 w-56" />
          </div>
        ) : (
          <dl className="grid gap-3">
            <Row label="Version">{data.version}</Row>
            <Row label="Build">
              <span className="font-mono text-sm" title={data.build_id}>
                {data.build_id.slice(0, 12)}
              </span>
            </Row>
            <Row label="Your records">
              <span className="font-mono text-sm">{data.data_dir}</span>
            </Row>
            <Row label="Daily backups">
              <span className="font-mono text-sm">{data.backup_dir}</span>
            </Row>
            <Row label="Log files">
              <span className="font-mono text-sm">{data.log_dir}</span>
            </Row>
            {data.feedback_waiting > 0 && (
              <Row label="Feedback">
                {plural(data.feedback_waiting, 'message')} waiting to be sent.{' '}
                {data.feedback_sending
                  ? 'It goes by itself when the internet is on.'
                  : 'It goes once a version that sends feedback is installed.'}
              </Row>
            )}
          </dl>
        )}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
