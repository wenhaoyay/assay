// Ctrl+K: jump to any chatbot, run, target, dataset or test case, or run an action.
// "compare 5 6" opens that comparison; "#12" opens run 12.
import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import {
  ArrowRight,
  Bot,
  Database,
  FileText,
  FlaskConical,
  GitCompareArrows,
  Keyboard,
  LayoutDashboard,
  Lightbulb,
  Moon,
  Play,
  Plug,
  Rows3,
  Scale,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Target,
  Zap,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { usePrefs } from '../lib/prefs'
import type { SearchResults } from '../lib/types'
import { Kbd } from './ui'

interface Item {
  id: string
  group: string
  label: ReactNode
  hint?: string
  icon: typeof Search
  run: () => void
  keywords?: string
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function CommandPalette({ open, onClose, onShortcuts, onTour }: { open: boolean; onClose: () => void; onShortcuts: () => void; onTour: () => void }) {
  const nav = useNavigate()
  const prefs = usePrefs()
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const dq = useDebounced(q, 120)
  const results = useQuery({
    queryKey: ['search', dq],
    queryFn: () => api.get<SearchResults>(`/api/search?q=${encodeURIComponent(dq)}`),
    enabled: open && dq.trim().length > 0,
  })

  useEffect(() => {
    if (open) {
      setQ('')
      setActive(0)
      setTimeout(() => input.current?.focus(), 10)
    }
  }, [open])

  // Leave no focus behind in the closing input, or the next shortcut would be typed into it.
  const go = (to: string) => () => { (document.activeElement as HTMLElement | null)?.blur(); onClose(); nav(to, { viewTransition: true }) }
  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    const ql = q.trim().toLowerCase()
    const cmp = ql.match(/^(?:compare|cmp|c)\s+#?(\d+)\s+(?:vs\s+|and\s+)?#?(\d+)$/)
    if (cmp) out.push({ id: 'cmp', group: 'Jump', label: <>Compare run <b>#{cmp[1]}</b> with <b>#{cmp[2]}</b></>, icon: GitCompareArrows, run: go(`/compare?baseline=${cmp[1]}&candidate=${cmp[2]}`) })
    const runId = ql.match(/^#?(\d+)$/)
    if (runId) out.push({ id: 'run', group: 'Jump', label: <>Open run <b>#{runId[1]}</b></>, icon: Rows3, run: go(`/runs/${runId[1]}`) })
    const actions: Item[] = [
      { id: 'a-run', group: 'Actions', label: 'New run', hint: 'Start a run on a chatbot version', icon: Play, run: go('/runs/new'), keywords: 'experiment start evaluate' },
      { id: 'a-connect', group: 'Actions', label: 'Connect a chatbot', hint: 'Paste a curl command, map the reply', icon: Plug, run: go('/targets/new'), keywords: 'target add wizard new' },
      { id: 'a-compare', group: 'Actions', label: 'Compare two runs', icon: GitCompareArrows, run: go('/compare'), keywords: 'diff baseline candidate' },
      { id: 'a-models', group: 'Actions', label: 'Models & keys', hint: 'Grading models, API keys', icon: Sparkles, run: go('/settings?tab=models'), keywords: 'judge openai api key provider settings' },
      { id: 'a-calibrate', group: 'Actions', label: 'Label answers (calibration)', icon: Scale, run: go('/calibration'), keywords: 'judge trust human label' },
      { id: 'a-bakeoff', group: 'Actions', label: 'Judge bake-off', hint: 'Which grading model agrees with you most?', icon: Zap, run: go('/calibration?tab=bakeoff'), keywords: 'judge compare models' },
      { id: 'a-explain', group: 'Preferences', label: prefs.explain ? 'Hide plain-English explanations' : 'Show plain-English explanations', icon: Lightbulb, run: () => { prefs.toggle('explain'); onClose() }, keywords: 'explain help jargon' },
      { id: 'a-theme', group: 'Preferences', label: prefs.theme === 'dark' ? 'Light mode' : 'Dark mode', icon: Moon, run: () => { prefs.toggle('theme'); onClose() }, keywords: 'theme dark light' },
      { id: 'a-density', group: 'Preferences', label: prefs.density === 'compact' ? 'Comfortable density' : 'Compact density', icon: Rows3, run: () => { prefs.toggle('density'); onClose() }, keywords: 'density compact rows' },
      { id: 'a-motion', group: 'Preferences', label: prefs.motion === 'reduced' ? 'Turn animations on' : 'Reduce motion', icon: Sparkles, run: () => { prefs.toggle('motion'); onClose() }, keywords: 'animation motion' },
      { id: 'a-keys', group: 'Help', label: 'Keyboard shortcuts', icon: Keyboard, run: () => { onClose(); onShortcuts() }, keywords: 'keys help' },
      { id: 'a-tour', group: 'Help', label: 'Take the tour', hint: 'A two-minute walk through GaugeLab', icon: Lightbulb, run: () => { onClose(); onTour() }, keywords: 'demo guide tour interview' },
      { id: 'p-home', group: 'Go to', label: 'Home', icon: LayoutDashboard, run: go('/') },
      { id: 'p-runs', group: 'Go to', label: 'Runs', icon: FlaskConical, run: go('/runs') },
      { id: 'p-targets', group: 'Go to', label: 'Targets', icon: Target, run: go('/targets') },
      { id: 'p-datasets', group: 'Go to', label: 'Datasets', icon: Database, run: go('/datasets') },
      { id: 'p-gates', group: 'Go to', label: 'Gates', icon: ShieldCheck, run: go('/gates') },
      { id: 'p-evaluators', group: 'Go to', label: 'Evaluators', icon: FileText, run: go('/evaluators') },
      { id: 'p-settings', group: 'Go to', label: 'Settings', icon: Settings, run: go('/settings') },
    ]
    out.push(...actions.filter((a) => !ql || `${typeof a.label === 'string' ? a.label : ''} ${a.hint ?? ''} ${a.keywords ?? ''} ${a.group}`.toLowerCase().includes(ql)))
    const r = results.data
    if (r && ql) {
      r.projects.forEach((p) => out.push({ id: `pr${p.id}`, group: 'Chatbots', label: p.name, icon: Bot, run: go(`/p/${p.id}`) }))
      r.runs.forEach((x) => out.push({ id: `r${x.id}`, group: 'Runs', label: <><span className="font-mono">#{x.id}</span> {x.name}</>, icon: Rows3, run: go(`/runs/${x.id}`) }))
      r.cases.forEach((c) => out.push({ id: `c${c.dataset_id}${c.id}`, group: 'Test cases', label: <><span className="font-mono">{c.id}</span> {c.title}</>, hint: c.dataset, icon: FileText, run: go(`/datasets/${c.dataset_id}?case=${encodeURIComponent(c.id)}`) }))
      r.targets.forEach((t) => out.push({ id: `t${t.id}`, group: 'Targets', label: t.name, icon: Target, run: go(`/targets/${t.id}`) }))
      r.datasets.forEach((d) => out.push({ id: `d${d.id}`, group: 'Datasets', label: d.name, icon: Database, run: go(`/datasets/${d.id}`) }))
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, results.data, prefs.explain, prefs.theme, prefs.density, prefs.motion])

  useEffect(() => setActive(0), [q])

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); items[active]?.run() }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }
  useEffect(() => {
    document.querySelector(`[data-cmd-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  let lastGroup = ''
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/30 p-4 pt-[12vh] backdrop-blur-[2px]"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.12 }} onMouseDown={onClose}>
          <motion.div role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}
            initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 500, damping: 36 }}
            className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
            <div className="flex items-center gap-2 border-b border-line px-4">
              <Search className="size-4 text-ink-3" aria-hidden />
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
                placeholder="Search runs, cases, chatbots... or type a command (compare 5 6)"
                className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-3" aria-label="Search" />
              <Kbd>Esc</Kbd>
            </div>
            <ul className="scroll-thin max-h-[52vh] overflow-y-auto p-2" role="listbox">
              {items.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-ink-3">{results.isFetching ? 'Searching...' : 'Nothing matches.'}</li>}
              {items.map((it, i) => {
                const header = it.group !== lastGroup ? it.group : null
                lastGroup = it.group
                const Icon = it.icon
                return (
                  <li key={it.id}>
                    {header && <div className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-ink-3">{header}</div>}
                    <button type="button" data-cmd-index={i} role="option" aria-selected={i === active} onMouseMove={() => setActive(i)} onClick={it.run}
                      className={clsx('flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px]', i === active ? 'bg-accent-wash text-ink' : 'text-ink-2')}>
                      <Icon className={clsx('size-4 shrink-0', i === active ? 'text-accent-ink' : 'text-ink-3')} aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{it.label}</span>
                      {it.hint && <span className="truncate text-xs text-ink-3">{it.hint}</span>}
                      {i === active && <ArrowRight className="size-3.5 text-accent-ink" aria-hidden />}
                    </button>
                  </li>
                )
              })}
            </ul>
            <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-ink-3">
              <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
              <span className="flex items-center gap-1"><Kbd>Enter</Kbd> open</span>
              <span className="ml-auto flex items-center gap-1"><Kbd>?</Kbd> all shortcuts</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export const SHORTCUTS: { group: string; keys: string[]; label: string }[] = [
  { group: 'Anywhere', keys: ['Ctrl', 'K'], label: 'Search and commands' },
  { group: 'Anywhere', keys: ['?'], label: 'This list' },
  { group: 'Anywhere', keys: ['E'], label: 'Plain-English explanations on/off' },
  { group: 'Anywhere', keys: ['G', 'H'], label: 'Go home' },
  { group: 'Anywhere', keys: ['G', 'R'], label: 'Go to runs' },
  { group: 'Anywhere', keys: ['G', 'C'], label: 'Go to compare' },
  { group: 'Anywhere', keys: ['G', 'T'], label: 'Go to targets' },
  { group: 'Anywhere', keys: ['G', 'S'], label: 'Go to settings' },
  { group: 'Anywhere', keys: ['N'], label: 'New run' },
  { group: 'Lists', keys: ['J'], label: 'Next row' },
  { group: 'Lists', keys: ['K'], label: 'Previous row' },
  { group: 'Lists', keys: ['Enter'], label: 'Open the picked row' },
  { group: 'Run page', keys: ['1'], label: 'Summary ... 6 Config (tabs by number)' },
  { group: 'Run page', keys: ['C'], label: 'Compare with the previous comparable run' },
  { group: 'Trial page', keys: ['['], label: 'Previous trial of this case' },
  { group: 'Trial page', keys: [']'], label: 'Next trial of this case' },
  { group: 'Trial page', keys: ['Shift', 'J'], label: 'Next failing case of this run' },
  { group: 'Calibration', keys: ['P'], label: 'Label PASS' },
  { group: 'Calibration', keys: ['F'], label: 'Label FAIL' },
  { group: 'Calibration', keys: ['U'], label: 'Label UNKNOWN' },
]

export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const groups = [...new Set(SHORTCUTS.map((s) => s.group))]
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/30 p-4 backdrop-blur-[2px]"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={onClose}>
          <motion.div role="dialog" aria-label="Keyboard shortcuts" onMouseDown={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }}
            className="w-full max-w-2xl rounded-2xl border border-line bg-surface p-5 shadow-pop">
            <div className="mb-4 flex items-center justify-between"><h2 className="text-[15px] font-semibold">Keyboard shortcuts</h2><Kbd>Esc</Kbd></div>
            <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
              {groups.map((g) => (
                <div key={g}>
                  <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">{g}</div>
                  <ul className="space-y-1">
                    {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                      <li key={s.label} className="flex items-center justify-between gap-3 text-[13px]">
                        <span className="text-ink-2">{s.label}</span>
                        <span className="flex gap-1">{s.keys.map((k) => <Kbd key={k}>{k}</Kbd>)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
