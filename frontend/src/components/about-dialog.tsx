/**
 * Settings → About: the version and build, whether a newer version is out (Check for updates,
 * Update now), and where the records, backups and logs live.
 */
import { useAbout, useCheckForUpdate } from '@/api/queries'
import type { UpdateInfo } from '@/api/types'
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
import { useUpdate } from '@/components/update'
import { errorMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { plural } from '@/lib/labels'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <dt className="text-sm font-semibold text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-base break-words">{children}</dd>
    </div>
  )
}

const CHECK_PROBLEM = {
  offline: 'Couldn’t check just now. Is the internet on?',
  rate_limited: 'GitHub asked the app to wait a while before checking again. Try later.',
  bad_answer: 'Couldn’t check just now. Try again later.',
} as const

const CANT_UPDATE = {
  not_installed: 'This copy can’t update itself (it isn’t an installed copy).',
  unsupported: 'This computer can’t update the app by itself.',
  no_download: 'It isn’t ready to download yet. Try again later.',
} as const

/** The "Newest version" line: what the last check found, in plain words. */
function updateStatus(info: UpdateInfo): string {
  if (info.reason === 'checks_off') return 'This copy of the app doesn’t look for new versions.'
  if (info.reason === 'updating') return `Updating to version ${info.last_attempt?.to_version}…`
  if (info.update_available && info.latest) {
    const why =
      info.reason && info.reason in CANT_UPDATE
        ? ` ${CANT_UPDATE[info.reason as keyof typeof CANT_UPDATE]}`
        : ''
    return `Version ${info.latest} is ready to install.${why}`
  }
  if (info.checked_at) return 'You have the newest version.'
  if (info.check_error) return CHECK_PROBLEM[info.check_error]
  return 'Not checked yet.'
}

function UpdateRows({ info, checkError }: { info: UpdateInfo; checkError: string | null }) {
  const problem =
    checkError ?? (info.check_error && info.checked_at ? CHECK_PROBLEM[info.check_error] : null)
  return (
    <Row label="Newest version">
      <span data-testid="update-status">{updateStatus(info)}</span>
      {info.checked_at && (
        <span className="block text-sm text-muted-foreground">
          Last checked {formatDateTime(info.checked_at)}.
        </span>
      )}
      {problem && <span className="block text-sm text-owed">{problem}</span>}
    </Row>
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
  const { info, ready, askToUpdate } = useUpdate()
  const check = useCheckForUpdate()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>About Scrappy Records</DialogTitle>
          <DialogDescription>
            Which version this is, whether there’s a newer one, and where your records are kept.
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
            {info && (
              <UpdateRows
                info={info}
                checkError={check.isError ? errorMessage(check.error) : null}
              />
            )}
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
        <DialogFooter className="flex-wrap gap-2">
          {info && info.reason !== 'checks_off' && (
            <Button
              variant="outline"
              className="sm:mr-auto"
              disabled={check.isPending || info.reason === 'updating'}
              onClick={() => check.mutate()}
            >
              {check.isPending ? 'Checking…' : 'Check for updates'}
            </Button>
          )}
          <Button variant={ready ? 'outline' : 'default'} onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {ready && (
            <Button
              onClick={() => {
                onOpenChange(false)
                askToUpdate()
              }}
            >
              Update now
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
