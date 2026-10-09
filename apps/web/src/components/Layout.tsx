import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  ChevronRight,
  Database,
  FileText,
  FlaskConical,
  GitCompareArrows,
  Keyboard,
  LayoutDashboard,
  Moon,
  Play,
  Scale,
  Search,
  Settings,
  ShieldCheck,
  Sun,
  Target,
} from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useCrumbsValue } from '../lib/crumbs'
import { useHotkey } from '../lib/hotkeys'
import { useMotionOn, usePrefs } from '../lib/prefs'
import type { Project } from '../lib/types'
import { CommandPalette, ShortcutSheet } from './CommandPalette'
import { Tour } from './Tour'
import { useLinkedHighlight } from './instrument'
import { Kbd, ProjectMark, Toaster, linkButton } from './ui'

const GROUPS = [
  {
    label: 'Results',
    items: [
      { to: '/', label: 'Home', icon: LayoutDashboard, end: true },
      { to: '/compare', label: 'Compare', icon: GitCompareArrows },
      { to: '/runs', label: 'Runs', icon: FlaskConical },
    ],
  },
  {
    label: 'Setup',
    items: [
      { to: '/targets', label: 'Connections', icon: Target },
      { to: '/datasets', label: 'Datasets', icon: Database },
      { to: '/gates', label: 'Gates', icon: ShieldCheck },
    ],
  },
  {
    label: 'Judge trust',
    items: [
      { to: '/calibration', label: 'Calibration', icon: Scale },
      { to: '/evaluators', label: 'Evaluators', icon: FileText },
    ],
  },
]

export function Logo({ live }: { live: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2.5 px-4 pb-3 pt-4" aria-label="Assay home">
      <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
        <rect width="32" height="32" rx="8" className="fill-ink" />
        <path d="M8 21a8 8 0 1 1 16 0" fill="none" className="stroke-surface" strokeWidth="2.5" strokeLinecap="round" />
        <g className={clsx(live && 'needle-live')}>
          <path d="M16 21l5-6" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
        </g>
        <circle cx="16" cy="21" r="2" className="fill-surface" />
      </svg>
      <span className="text-base font-semibold tracking-tight max-md:hidden">Assay</span>
      {live && <span className="relative ml-auto flex size-2 max-md:hidden" title="A run is in progress"><span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" /><span className="relative inline-flex size-2 rounded-full bg-accent" /></span>}
    </Link>
  )
}

function NavItem({ to, label, icon: Icon, end }: { to: string; label: string; icon: typeof Target; end?: boolean }) {
  return (
    <NavLink to={to} end={end} title={label} viewTransition
      className={({ isActive }) => clsx('group relative flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-base transition-colors duration-150',
        isActive ? 'bg-surface text-ink shadow-[inset_0_0_0_1px_var(--line)]' : 'text-ink-3 hover:bg-surface-2 hover:text-ink')}>
      {({ isActive }) => (
        <>
          {isActive && <span className="absolute -left-2.5 top-[7px] bottom-[7px] w-[3px] rounded-full bg-accent" aria-hidden />}
          <Icon className="size-4 shrink-0" aria-hidden />
          <span className="max-md:hidden">{label}</span>
        </>
      )}
    </NavLink>
  )
}

function Sidebar({ live }: { live: boolean }) {
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<Project[]>('/api/projects') })
  const prefs = usePrefs()
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-[color-mix(in_oklch,var(--page)_70%,var(--surface-2))] max-md:w-14">
      <Logo live={live} />
      <nav className="scroll-thin flex-1 overflow-y-auto px-2.5 pb-3" aria-label="Main">
        {GROUPS.map((g, gi) => (
          <div key={g.label}>
            <div className="t-label mx-2 mb-1 mt-3.5 max-md:hidden">{g.label}</div>
            <div className="space-y-0.5">
              {g.items.map((it) => <NavItem key={it.to} {...it} />)}
            </div>
            {gi === 0 && (projects.data?.length ?? 0) > 0 && (
              <div className="mt-1 space-y-0.5 max-md:hidden" aria-label="Chatbots">
                {projects.data!.map((p) => (
                  <NavLink key={p.id} to={`/p/${p.id}`} viewTransition
                    className={({ isActive }) => clsx('relative flex items-center gap-2.5 rounded-lg py-1 pl-2.5 pr-2 text-sm transition-colors duration-150',
                      isActive ? 'bg-surface text-ink shadow-[inset_0_0_0_1px_var(--line)]' : 'text-ink-3 hover:bg-surface-2 hover:text-ink')}>
                    {({ isActive }) => (
                      <>
                        {isActive && <span className="absolute -left-2.5 top-[6px] bottom-[6px] w-[3px] rounded-full bg-accent" aria-hidden />}
                        <ProjectMark name={p.name} color={p.color} size={16} /><span className="truncate">{p.name}</span>
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="space-y-0.5 border-t border-line px-2.5 py-2">
        <NavItem to="/settings" label="Settings" icon={Settings} />
        <button type="button" onClick={() => prefs.toggle('theme')}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-base text-ink-3 transition-colors duration-150 hover:bg-surface-2 hover:text-ink">
          {prefs.theme === 'dark' ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
          <span className="max-md:hidden">{prefs.theme === 'dark' ? 'Light mode' : 'Dark mode'}</span>
        </button>
      </div>
    </aside>
  )
}

function TopBar({ onPalette, onShortcuts }: { onPalette: () => void; onShortcuts: () => void }) {
  const crumbs = useCrumbsValue()
  return (
    <div data-topbar className="sticky top-0 z-30 flex h-[52px] items-center gap-2.5 border-b border-line bg-page/80 px-8 backdrop-blur-md max-sm:px-4">
      <nav aria-label="Breadcrumb" className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-ink-3">
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-ink-3" aria-hidden />}
            {c.to && i < crumbs.length - 1 ? (
              <Link to={c.to} viewTransition className="truncate text-ink-3 hover:text-ink">{c.label}</Link>
            ) : (
              <span className={clsx('truncate', i === crumbs.length - 1 ? 'font-medium text-ink' : 'text-ink-3')}>{c.label}</span>
            )}
          </Fragment>
        ))}
      </nav>
      <button type="button" onClick={onPalette} data-tour="palette"
        className="flex h-8 w-60 items-center gap-2 rounded-lg border border-line bg-surface px-2.5 text-sm text-ink-3 shadow-[inset_0_-1.5px_0_color-mix(in_oklch,var(--ink)_5%,transparent)] transition-colors duration-150 hover:border-line-strong hover:text-ink-2 max-lg:w-auto">
        <Search className="size-3.5" aria-hidden /><span className="flex-1 truncate whitespace-nowrap text-left max-lg:hidden">Search or command</span>
        <span className="flex gap-0.5 max-lg:hidden"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>
      </button>
      <button type="button" onClick={onShortcuts} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts"
        className="flex size-8 items-center justify-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink max-sm:hidden">
        <Keyboard className="size-4" aria-hidden />
      </button>
      <Link to="/runs/new" viewTransition className={linkButton('primary')} data-tour="new-run"><Play className="size-3.5" aria-hidden /><span className="max-sm:hidden">New run</span></Link>
    </div>
  )
}

export function Layout() {
  const nav = useNavigate()
  const loc = useLocation()
  const [palette, setPalette] = useState(false)
  const [shortcuts, setShortcuts] = useState(false)
  const [tour, setTour] = useState(false)
  const activity = useQuery({
    queryKey: ['activity'],
    queryFn: () => api.get<{ active_runs: { id: number }[] }>('/api/activity'),
    refetchInterval: (q) => (q.state.data?.active_runs.length ? 3000 : 20_000),
  })
  const live = (activity.data?.active_runs.length ?? 0) > 0
  const go = (to: string) => nav(to, { viewTransition: true })
  useLinkedHighlight()
  const motionOn = useMotionOn()
  // <main> is the scroll container, so a #hash link needs the element scrolled into view by hand;
  // the target may render a moment after the route (data loads), so look a few times.
  useEffect(() => {
    const id = decodeURIComponent(loc.hash.replace(/^#/, ''))
    if (!id) return
    let tries = 0
    const t = setInterval(() => {
      const el = document.getElementById(id)
      if (el || ++tries > 20) { clearInterval(t); el?.scrollIntoView({ block: 'start', behavior: motionOn ? 'smooth' : 'auto' }) }
    }, 100)
    return () => clearInterval(t)
  }, [loc.pathname, loc.hash, motionOn])

  useHotkey('mod+k', () => setPalette((v) => !v))
  useHotkey('?', () => setShortcuts((v) => !v))
  useHotkey('escape', () => { setShortcuts(false) }, shortcuts)
  useHotkey('n', () => go('/runs/new'), !loc.pathname.startsWith('/runs/new'))
  useHotkey('g h', () => go('/'))
  useHotkey('g r', () => go('/runs'))
  useHotkey('g c', () => go('/compare'))
  useHotkey('g t', () => go('/targets'))
  useHotkey('g d', () => go('/datasets'))
  useHotkey('g s', () => go('/settings'))

  return (
    <div className="flex h-full">
      <Sidebar live={live} />
      <main className="scroll-thin min-w-0 flex-1 overflow-y-auto" id="main">
        <TopBar onPalette={() => setPalette(true)} onShortcuts={() => setShortcuts(true)} />
        <div className="mx-auto max-w-[1360px] px-8 pb-20 pt-7 max-sm:px-4">
          <Outlet context={{ startTour: () => setTour(true) }} />
        </div>
      </main>
      <CommandPalette open={palette} onClose={() => setPalette(false)} onShortcuts={() => setShortcuts(true)} onTour={() => setTour(true)} />
      <ShortcutSheet open={shortcuts} onClose={() => setShortcuts(false)} />
      <Toaster />
      {tour && <Tour open onClose={() => setTour(false)} />}
    </div>
  )
}
