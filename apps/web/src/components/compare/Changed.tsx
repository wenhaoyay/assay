// 6.9 What changed: one row per question, worst first, with a mini dumbbell (blue = baseline rate,
// orange = candidate) and the change in tries. A row opens the candidate's answer; the chevron
// shows both answers side by side.
import clsx from 'clsx'
import { Check, ChevronRight, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { PairedCase } from '../../lib/compare'
import { FAILURE_LABELS } from '../../lib/format'
import type { CaseChange, Comparison, TrialRow } from '../../lib/types'
import { Delta } from '../instrument'
import { Badge, Card, DotStrip, Segmented } from '../ui'
import { AnswerText } from '../trial/AnswerText'

const rate = (s: { passed: number; total: number } | null) => (s && s.total ? s.passed / s.total : null)

export function Dumbbell({ a, b, width = 150 }: { a: number | null; b: number | null; width?: number }) {
  const x = (v: number) => 8 + v * (width - 16)
  const d = a !== null && b !== null ? b - a : 0
  return (
    <svg width={width} height={22} aria-hidden className="shrink-0 overflow-visible">
      <line x1={8} x2={width - 8} y1={11} y2={11} stroke="var(--line)" />
      {a !== null && b !== null && <line x1={x(a)} x2={x(b)} y1={11} y2={11} stroke={d > 0 ? 'var(--good)' : d < 0 ? 'var(--bad)' : 'var(--line-strong)'} strokeWidth={2.5} />}
      {a !== null && <circle cx={x(a)} cy={11} r={4} fill="var(--series-1)" />}
      {b !== null && <circle cx={x(b)} cy={11} r={4} fill="var(--series-2)" />}
    </svg>
  )
}

export function Changed({ cases, c, baseTrials, candTrials }: { cases: PairedCase[]; c: Comparison; baseTrials: TrialRow[]; candTrials: TrialRow[] }) {
  const nav = useNavigate()
  const shared = useMemo(() => cases.filter((x) => x.a && x.b), [cases])
  const changed = useMemo(() => shared.filter((x) => x.d !== 0), [shared])
  const [filter, setFilter] = useState<'changed' | 'all'>(changed.length ? 'changed' : 'all')
  const [open, setOpen] = useState<string | null>(null)
  const rows = (filter === 'changed' ? changed : shared).slice().sort((p, q) => p.d - q.d)
  const meta = useMemo(() => new Map<string, CaseChange>([...c.regressions, ...c.improvements].map((x) => [x.case_id, x])), [c])
  return (
    <Card title="What changed"
      help={<>
        <p>Questions whose result changed between the two runs, worst first. The blue dot is #{c.baseline_run.id}'s pass rate on that question, the orange dot #{c.candidate_run.id}'s; the line is green when it rose and red when it fell. The figure is how many of the tries moved.</p>
        <p>Click a row to open #{c.candidate_run.id}'s answer; the arrow on the right shows both answers side by side. "All" lists every shared question.</p>
      </>}
      actions={<Segmented size="sm" value={filter} onChange={setFilter} label="Which questions"
        options={[{ id: 'changed', label: <>Changed only · <span className="font-mono">{changed.length}</span></> }, { id: 'all', label: <>All <span className="font-mono">{shared.length}</span></> }]} />}>
      <ul className="scroll-thin max-h-[460px] divide-y divide-line overflow-y-auto" data-testid="changed-list">
        {rows.map((r) => {
          const tries = r.b!.total || r.a!.total || 1
          const m = meta.get(r.id)
          const why = m && (r.d < 0 ? m.candidate_failure_types : m.baseline_failure_types)
          return (
            <li key={r.id} data-case={r.id}>
              <div className="flex items-center gap-3 py-2 pl-1">
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => r.bTrial && nav(`/trials/${r.bTrial}`)} title="Open the candidate's answer">
                  <span className="block truncate text-sm font-medium text-ink hover:text-accent-ink">{r.title}</span>
                  <span className="block truncate text-xs text-ink-3"><span className="font-mono">{r.id}</span>{why && why.length > 0 && <> · {r.d < 0 ? 'now' : 'was'}: {why.map((f) => FAILURE_LABELS[f] ?? f).join(', ').toLowerCase()}</>}</span>
                </button>
                <span className="max-sm:hidden"><Dumbbell a={rate(r.a)} b={rate(r.b)} /></span>
                <span className="w-14 text-right text-xs">
                  {r.d === 0 ? <span className="text-ink-3">same</span> : <Delta value={r.d} noise={0.001} format={(v) => `${Math.round(v * tries)}/${tries}`} />}
                </span>
                <button type="button" aria-label={`Both answers for ${r.id}`} aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}
                  className="rounded-md p-1 text-ink-3 hover:bg-surface-2 hover:text-ink">
                  <ChevronRight className={clsx('size-4 transition-transform', open === r.id && 'rotate-90')} />
                </button>
              </div>
              <AnimatePresence initial={false}>
                {open === r.id && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    <SideBySide caseId={r.id} c={c} sides={[baseTrials, candTrials]} />
                  </motion.div>
                )}
              </AnimatePresence>
            </li>
          )
        })}
        {!rows.length && <li className="py-4 text-sm text-ink-3">No question changed result between these runs.</li>}
      </ul>
    </Card>
  )
}

/** The same question in both runs: answers next to each other, with each side's failing checks. */
function SideBySide({ caseId, c, sides }: { caseId: string; c: Comparison; sides: [TrialRow[], TrialRow[]] }) {
  const runs = [c.baseline_run, c.candidate_run]
  const picks = sides.map((ts) => ts.filter((t) => t.case_id === caseId).sort((x, y) => (x.status === 'passed' ? 1 : 0) - (y.status === 'passed' ? 1 : 0) || x.trial_index - y.trial_index))
  return (
    <div className="mb-2 grid gap-3 md:grid-cols-2">
      {picks.map((ts, i) => (
        <div key={i} className="min-w-0 rounded-lg border border-line bg-surface p-3">
          <div className="mb-1.5 flex items-center gap-2 text-xs">
            <span className={clsx('size-2 rounded-full', i === 0 ? 'bg-series-1' : 'bg-series-2')} />
            <span className="font-medium">{i === 0 ? 'Baseline' : 'Candidate'} #{runs[i].id}</span>
            <DotStrip statuses={ts.map((t) => t.status)} />
            {ts[0] && <Link to={`/trials/${ts[0].id}`} className="ml-auto text-accent-ink hover:underline">open try</Link>}
          </div>
          {ts[0] ? (
            <>
              <div className="line-clamp-6 whitespace-pre-wrap text-sm leading-relaxed"><AnswerText text={ts[0].answer} good={[]} bad={[]} /></div>
              <div className="mt-2 flex flex-wrap gap-1">
                {ts[0].status === 'passed' ? <Badge tone="good"><Check className="size-3" />all checks passed</Badge> : ts[0].failed_evaluators.map((e) => <Badge key={e} tone="bad"><X className="size-3" />{e}</Badge>)}
              </div>
            </>
          ) : <p className="text-xs text-ink-3">Not in this run.</p>}
        </div>
      ))}
    </div>
  )
}
