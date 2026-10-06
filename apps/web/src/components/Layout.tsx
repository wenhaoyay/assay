import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  BarChart3,
  Database,
  FlaskConical,
  GitCompareArrows,
  LayoutDashboard,
  ListChecks,
  Moon,
  Network,
  Scale,
  Sun,
  Target,
} from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { api } from '../lib/api'

const NAV = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/targets', label: 'Targets', icon: Target },
  { to: '/datasets', label: 'Datasets', icon: Database },
  { to: '/experiments', label: 'Experiments', icon: FlaskConical },
  { to: '/compare', label: 'Compare', icon: GitCompareArrows },
  { to: '/evaluators', label: 'Evaluators', icon: ListChecks },
  { to: '/calibration', label: 'Calibration', icon: Scale },
  { to: '/traces', label: 'Traces', icon: Network },
]

function Logo() {
  return (
    <div className="flex items-center gap-2 px-3 py-4">
      <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
        <rect width="32" height="32" rx="7" className="fill-ink" />
        <path d="M8 21a8 8 0 1 1 16 0" fill="none" className="stroke-surface" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M16 21l5-6" stroke="var(--series-1)" strokeWidth="2.5" strokeLinecap="round" />
        <circle cx="16" cy="21" r="2" className="fill-surface" />
      </svg>
      <span className="text-[15px] font-semibold tracking-tight">GaugeLab</span>
    </div>
  )
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light')
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      onClick={() => {
        document.documentElement.dataset.theme = next
        try {
          localStorage.setItem('gl-theme', next)
        } catch {
          /* private mode */
        }
        setTheme(next)
      }}
      className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink"
    >
      {theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
      {theme === 'dark' ? 'Light mode' : 'Dark mode'}
    </button>
  )
}

function ApiStatus() {
  const q = useQuery({ queryKey: ['health'], queryFn: () => api.get<{ version: string; database: string }>('/api/health'), refetchInterval: 30_000 })
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-ink-3">
      <span className={clsx('size-2 rounded-full', q.isSuccess ? 'bg-good' : q.isError ? 'bg-bad' : 'bg-line-strong')} aria-hidden />
      {q.isSuccess ? `API v${q.data.version} - ${q.data.database}` : q.isError ? 'API unreachable' : 'Connecting'}
    </div>
  )
}

export function Layout() {
  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-surface max-md:w-14">
        <Logo />
        <nav className="flex-1 space-y-0.5 px-2" aria-label="Main">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              title={label}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-2.5 rounded-md px-3 py-1.5 text-[13px]',
                  isActive ? 'bg-surface-2 font-medium text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                )
              }
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="max-md:hidden">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="space-y-1 border-t border-line p-2 max-md:hidden">
          <ThemeToggle />
          <ApiStatus />
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-md px-3 py-1.5 text-xs text-ink-3 hover:text-ink"
          >
            <BarChart3 className="size-3.5" aria-hidden /> API reference (OpenAPI)
          </a>
        </div>
      </aside>
      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1360px] px-6 py-6 max-sm:px-4">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
