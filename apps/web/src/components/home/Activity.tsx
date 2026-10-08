// Home: the recent-activity stream and the "worth a look" list.
import clsx from 'clsx'
import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { FAILURE_LABELS, pct } from '../../lib/format'
import { useMotionOn } from '../../lib/prefs'
import type { CaseChange, RunHeader } from '../../lib/types'
import { Badge } from '../ui'
import { dayLabel } from './shared'

const DOT: Record<string, string> = { pass: 'bg-good', fail: 'bg-bad', warn: 'bg-warn', info: 'bg-series-1', idle: 'bg-untested', live: 'bg-accent' }

interface Event { key: string; dot: keyof typeof DOT; body: ReactNode; at: string | null; to: string }

export function ActivityStream({ runs, projectName, gates, multi }: {
  runs: RunHeader[]
  projectName: (id: number | null | undefined) => string
  gates: Record<number, number>
  multi: boolean
}) {
  const motionOn = useMotionOn()
  const events: Event[] = []
  // A gate line only when a chatbot's gate result changes, and for its newest gated run.
  const showGate = new Set<number>()
  const last: Record<number, string> = {}
  const gated = [...runs].filter((r) => (r.gate_status === 'PASS' || r.gate_status === 'FAIL') && !r.off_topic).sort((a, b) => a.id - b.id)
  for (const r of gated) {
    const k = r.project_id ?? 0
    if (last[k] !== r.gate_status) showGate.add(r.id)
    last[k] = r.gate_status!
  }
  for (const k of Object.keys(last)) {
    const newest = gated.filter((r) => (r.project_id ?? 0) === Number(k)).at(-1)
    if (newest) showGate.add(newest.id)
  }
  for (const r of runs) {
    const at = r.finished_at ?? r.started_at ?? r.created_at
    const of = multi && r.project_id ? <span className="text-ink-3"> · {projectName(r.project_id)}</span> : null
    const id = <span className="font-mono">#{r.id}</span>
    if (r.status === 'running' || r.status === 'queued') {
      events.push({ key: `r${r.id}`, dot: 'live', at, to: `/runs/${r.id}`, body: <>Run {id} <span className="font-semibold">is {r.status}</span>: <span className="font-mono">{r.progress_done}/{r.progress_total}</span> tries{of}</> })
      continue
    }
    if (r.status === 'failed' || r.status === 'cancelled') {
      events.push({ key: `r${r.id}`, dot: 'idle', at, to: `/runs/${r.id}`, body: <>Run {id} <span className="font-semibold">{r.status === 'failed' ? 'stopped with an error' : 'was cancelled'}</span>{of}</> })
      continue
    }
    if (r.off_topic) {
      events.push({ key: `r${r.id}`, dot: 'warn', at, to: `/runs/${r.id}`, body: <>Run {id} <span className="font-semibold">asked another chatbot’s questions</span> ({r.off_topic}). Left out of trends.{of}</> })
      continue
    }
    if (showGate.has(r.id)) {
      events.push({ key: `g${r.id}`, dot: r.gate_status === 'PASS' ? 'pass' : 'fail', at, to: `/runs/${r.id}`, body: <>Release gate <span className="font-semibold">{r.gate_status === 'PASS' ? 'passed' : 'failed'}</span> on run {id}.{of}</> })
    }
    const rate = r.metrics.overall_pass_rate
    const gate = r.project_id ? gates[r.project_id] : undefined
    const dot = r.gate_status === 'PASS' ? 'pass' : r.gate_status === 'FAIL' ? 'fail' : gate !== undefined && rate != null ? (rate >= gate ? 'pass' : 'fail') : 'info'
    events.push({ key: `r${r.id}`, dot, at, to: `/runs/${r.id}`, body: <>Run {id} finished: <span className="font-mono">{pct(rate)}</span> · {r.variant_label || r.target}{of}</> })
  }
  if (!events.length) return <p className="text-sm text-ink-3">No runs yet. The first one will show up here.</p>
  return (
    <ul data-testid="activity">
      {events.slice(0, 10).map((e, i) => (
        <motion.li key={e.key} initial={motionOn ? { opacity: 0, y: -6 } : false} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="border-b border-dashed border-line">
          <Link to={e.to} viewTransition className="grid grid-cols-[18px_minmax(0,1fr)_auto] gap-2.5 py-2.5 text-sm text-ink-2 hover:text-ink">
            <span className={clsx('mt-1.5 size-2 rounded-full', DOT[e.dot])} />
            <span>{e.body}</span>
            <span className="font-mono text-ink-3">{dayLabel(e.at)}</span>
          </Link>
        </motion.li>
      ))}
    </ul>
  )
}

export interface LookItem { key: string; dot: string; title: ReactNode; body: ReactNode; chip: ReactNode; to: string; caseId?: string }

export function regressionItem(r: CaseChange, baselineId: number, trialFor: (caseId: string) => number | undefined, latestId: number): LookItem {
  const before = r.baseline_pass_rate === 1 ? `passed every try in #${baselineId}` : `passed ${pct(r.baseline_pass_rate, 0)} of tries in #${baselineId}`
  const now = r.candidate_pass_rate === 0 ? 'fails every try now' : `${pct(r.candidate_pass_rate, 0)} now`
  const why = r.candidate_failure_types.map((x) => FAILURE_LABELS[x] ?? x.replace(/_/g, ' ')).join(', ')
  const t = trialFor(r.case_id)
  return {
    key: `reg-${r.case_id}`, dot: 'bg-bad', caseId: r.case_id,
    title: <>{r.title} <span className="font-mono text-sm font-normal text-ink-3">{r.case_id}</span></>,
    body: <>{before}, {now}{why ? `: ${why}` : ''}</>,
    chip: <Badge tone="bad">regressed</Badge>,
    to: t ? `/trials/${t}` : `/runs/${latestId}`,
  }
}

export function WorthALook({ items }: { items: LookItem[] }) {
  if (!items.length) {
    return (
      <div className="flex items-center gap-2.5 py-2 text-sm text-ink-2" data-testid="worth-a-look">
        <span className="size-2 rounded-full bg-good" />Nothing needs a look: no regressions, nothing flaky, nothing left out.
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3.5" data-testid="worth-a-look">
      {items.map((it) => (
        <Link key={it.key} to={it.to} viewTransition data-case={it.caseId} className="group grid grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-2.5">
          <span className={clsx('mt-1.5 size-2 rounded-full', it.dot)} />
          <span className="min-w-0">
            <span className="block text-base font-semibold group-hover:underline">{it.title}</span>
            <span className="block text-sm text-ink-2">{it.body}</span>
          </span>
          <span className="mt-0.5">{it.chip}</span>
        </Link>
      ))}
    </div>
  )
}
