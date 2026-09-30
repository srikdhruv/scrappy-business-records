import {
  LayoutDashboardIcon,
  ReceiptIndianRupeeIcon,
  UsersIcon,
  type LucideIcon,
} from 'lucide-react'
import { NavLink, Outlet } from 'react-router'

import { useHealth } from '@/api/queries'
import { LogPaymentButton } from '@/components/log-payment'
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
      {data ? `Version ${data.version}` : ' '}
    </p>
  )
}

export function AppShell() {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-4 border-b border-sidebar-border bg-sidebar p-4 text-sidebar-foreground md:sticky md:top-0 md:h-screen md:w-64 md:gap-6 md:border-r md:border-b-0 md:p-5">
        <div className="flex items-center justify-between gap-3 md:flex-col md:items-stretch md:gap-6">
          <NavLink
            to="/"
            className="flex items-center gap-3 rounded-lg"
            aria-label="Scrappy Records home"
          >
            <BrandMark />
            <span className="text-xl font-extrabold tracking-tight">Scrappy Records</span>
          </NavLink>
          <LogPaymentButton className="md:w-full" />
        </div>

        <nav aria-label="Main">
          <ul className="flex gap-1 md:flex-col">
            {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2.5 text-base font-semibold transition-colors',
                      'hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-muted-foreground hover:text-sidebar-foreground',
                    )
                  }
                >
                  <Icon className="size-5" aria-hidden />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-auto hidden md:block">
          <AppVersion />
        </div>
      </aside>

      <main className="flex-1 px-4 py-6 md:px-10 md:py-8">
        <div className="mx-auto w-full max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
