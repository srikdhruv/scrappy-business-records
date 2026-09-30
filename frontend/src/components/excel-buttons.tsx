/** Download Excel and Upload Excel, under a page's title (Students and Payments). */
import { DatabaseBackupIcon, FileDownIcon, FileUpIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EVERYTHING_DOWNLOAD_URL } from '@/lib/downloads'

export function ExcelButtons({
  downloadHref,
  onUpload,
  everything = false,
}: {
  /** What's shown on the page, as an Excel file. */
  downloadHref: string
  onUpload: () => void
  /** Also Download everything (it's in the side menu too, but that's hidden on a narrow window). */
  everything?: boolean
}) {
  return (
    <div className="-ml-3 flex flex-wrap items-center gap-1 pt-1">
      <Button variant="ghost" size="sm" asChild>
        <a href={downloadHref} download>
          <FileDownIcon className="text-primary-strong" aria-hidden />
          Download Excel
        </a>
      </Button>
      <Button variant="ghost" size="sm" onClick={onUpload}>
        <FileUpIcon className="text-primary-strong" aria-hidden />
        Upload Excel
      </Button>
      {everything && (
        <Button variant="ghost" size="sm" asChild>
          <a href={EVERYTHING_DOWNLOAD_URL} download>
            <DatabaseBackupIcon className="text-primary-strong" aria-hidden />
            Download everything
          </a>
        </Button>
      )}
    </div>
  )
}
