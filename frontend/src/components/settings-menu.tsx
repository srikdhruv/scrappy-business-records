/**
 * The gear button at the bottom left (in the top bar on a narrow window) and its small menu:
 * Send feedback, and About. Future settings (the business name, say) go here too.
 *
 * The dialogs live in `SettingsDialogs`, rendered once by the app shell, so the two gear
 * buttons (wide and narrow layouts) open the same ones.
 */
import { InfoIcon, MessageSquareIcon, SettingsIcon } from 'lucide-react'

import { AboutDialog } from '@/components/about-dialog'
import { FeedbackDialog } from '@/components/feedback-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

export type SettingsDialog = 'feedback' | 'about' | null

export function SettingsMenu({
  onOpen,
  showLabel = false,
  className,
}: {
  onOpen: (dialog: Exclude<SettingsDialog, null>) => void
  /** "Settings" next to the gear (the sidebar), or the gear alone (the narrow top bar). */
  showLabel?: boolean
  className?: string
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={showLabel ? 'default' : 'icon'}
          aria-label="Settings"
          className={cn(
            'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
            showLabel && 'justify-start px-3 font-bold',
            className,
          )}
        >
          <SettingsIcon className="size-5" aria-hidden />
          {showLabel && 'Settings'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuItem className="py-2 text-base" onSelect={() => onOpen('feedback')}>
          <MessageSquareIcon className="size-4" aria-hidden />
          Send feedback
        </DropdownMenuItem>
        {/*
          Your data: "Download everything" (Excel, PR #12) belongs here once it's on main,
          as another item, e.g. <DropdownMenuItem asChild><a href=... download>…</a>.
        */}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="py-2 text-base" onSelect={() => onOpen('about')}>
          <InfoIcon className="size-4" aria-hidden />
          About
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function SettingsDialogs({
  open,
  onOpenChange,
}: {
  open: SettingsDialog
  onOpenChange: (open: SettingsDialog) => void
}) {
  return (
    <>
      <FeedbackDialog
        open={open === 'feedback'}
        onOpenChange={(o) => onOpenChange(o ? 'feedback' : null)}
      />
      <AboutDialog open={open === 'about'} onOpenChange={(o) => onOpenChange(o ? 'about' : null)} />
    </>
  )
}
