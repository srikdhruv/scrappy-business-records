import {
  CloudOffIcon,
  LayoutDashboardIcon,
  ReceiptIndianRupeeIcon,
  ShieldCheckIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router'
import { useEffect, useState } from 'react'

import { useHealth, useServerReachable } from '@/api/queries'
import { SettingsDialogs, SettingsMenu, type SettingsDialog } from '@/components/settings-menu'
import { UNREACHABLE_MESSAGE } from '@/lib/errors'
import { cn } from '@/lib/utils'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboardIcon, end: true },
  { to: '/payments', label: 'Payments', icon: ReceiptIndianRupeeIcon },
  { to: '/students', label: 'Students', icon: UsersIcon },
]

function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" className="size-9 shrink-0" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--primary)" />
      <path
        d="M10 9.5h9.5a3.5 3.5 0 0 1 0 7H14l6.5 6.5"
        fill="none"
        stroke="var(--primary-foreground)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 13h12"
        stroke="var(--primary-foreground)"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function AppVersion() {
  const { data } = useHealth()
  return (
    <p className="text-xs text-muted-foreground" data-testid="app-version">
      {data ? `Version ${data.version}` : ' '}
    </p>
  )
}

/** Shown on every page while the server isn't answering, so old numbers aren't trusted. */
function UnreachableBanner() {
  return (
    <div
      role="alert"
      className="mb-6 flex items-start gap-3 rounded-xl border border-owed/25 bg-owed-soft px-4 py-3 text-base text-owed print:hidden"
    >
      <CloudOffIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
      <p>
        <strong>{UNREACHABLE_MESSAGE}</strong>{' '}
        <span className="text-foreground/80">The numbers on this page may be out of date.</span>
      </p>
    </div>
  )
}

export function AppShell() {
  const { pathname } = useLocation()
  const reachable = useServerReachable()
  const [dialog, setDialog] = useState<SettingsDialog>(null)
  // Each page starts at the top, like a normal website.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside className="shrink-0 border-b border-sidebar-border bg-sidebar text-sidebar-foreground lg:w-60 lg:border-r lg:border-b-0 print:hidden">
        <div className="flex flex-col gap-3 px-4 py-3 lg:sticky lg:top-0 lg:h-screen lg:gap-8 lg:py-6">
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 lg:flex-col lg:items-stretch lg:gap-8">
            <NavLink
              to="/"
              className="flex items-center gap-3 rounded-lg px-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label="Scrappy Records home"
            >
              <BrandMark />
              <span className="text-xl font-extrabold tracking-tight">Scrappy Records</span>
            </NavLink>

            {/* Narrow window: the gear sits in the top bar. */}
            <SettingsMenu onOpen={setDialog} className="lg:hidden" />

            <nav aria-label="Main" className="w-full sm:w-auto lg:w-full">
              <ul className="flex gap-1 lg:flex-col">
                {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
                  <li key={to}>
                    <NavLink
                      to={to}
                      end={end}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-3 rounded-xl px-3 py-2.5 text-base font-bold transition-colors',
                          'outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                          isActive
                            ? 'bg-card text-foreground shadow-soft'
                            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <Icon
                            className={cn('size-5', isActive && 'text-primary-strong')}
                            aria-hidden
                          />
                          {label}
                        </>
                      )}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          </div>

          <div className="mt-auto hidden space-y-3 px-2 lg:block">
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-paid" aria-hidden />
              Your records stay on this laptop and are backed up every day.
            </p>
            <div className="-mx-2 flex items-center justify-between gap-2">
              <SettingsMenu onOpen={setDialog} showLabel />
              <AppVersion />
            </div>
          </div>
        </div>
      </aside>
      <SettingsDialogs open={dialog} onOpenChange={setDialog} />

      <main className="min-w-0 flex-1 px-5 py-6 sm:px-8 lg:px-10 lg:py-8 print:p-0">
        <div className="mx-auto w-full max-w-6xl print:max-w-none">
          {!reachable && <UnreachableBanner />}
          <Outlet />
        </div>
      </main>
    </div>
  )
}
