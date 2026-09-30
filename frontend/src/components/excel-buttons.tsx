/** Download Excel and Upload Excel, under a page's title (Students and Payments). */
import { FileDownIcon, FileUpIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'

export function ExcelButtons({
  downloadHref,
  onUpload,
}: {
  /** What's shown on the page, as an Excel file. */
  downloadHref: string
  onUpload: () => void
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
    </div>
  )
}
