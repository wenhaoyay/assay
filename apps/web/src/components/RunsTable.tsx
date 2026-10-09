import clsx from 'clsx'
import { motion } from 'motion/react'
import { Link, useNavigate } from 'react-router-dom'
import { ms, pct, when } from '../lib/format'
import { useListNav } from '../lib/hotkeys'
import { questionsOf } from '../lib/runstate'
import type { RunHeader } from '../lib/types'
import { Checkbox } from './form'
import { Badge, RunStatus, StatusBadge } from './ui'
import { ScrollTable } from './Layout'

/** The pass rate as a short bar with its 95% interval behind it. Heuristic grades are hatched. */
function PassBar({ value, ci, heuristic = false, muted = false }: { value: number | null | undefined; ci?: [number | null, number | null]; heuristic?: boolean; muted?: boolean }) {
  if (value === null || value === undefined) return null
  const [lo, hi] = ci ?? [null, null]
  return (
    <span className="relative inline-block h-1.5 w-20 overflow-hidden rounded-full bg-surface-3 align-middle"
      title={lo !== null && hi !== null ? `${pct(value)} (95% interval ${pct(lo)} to ${pct(hi)})` : pct(value)}>
      {lo !== null && hi !== null && (
        <span className="absolute inset-y-0 bg-accent/25" style={{ left: `${lo * 100}%`, width: `${Math.max(1, (hi - lo) * 100)}%` }} />
      )}
      <motion.span className={clsx('absolute inset-y-0 left-0 rounded-full', muted ? 'bg-warn/70' : 'bg-accent', heuristic && 'hatched-light')}
        initial={{ width: 0 }} animate={{ width: `${value * 100}%` }} transition={{ type: 'spring', stiffness: 140, damping: 22 }} />
    </span>
  )
}

/** Runs, newest first. With ``selectable``, tick two to compare them. j/k + Enter open a run. */
export function RunsTable({ runs, compact = false, selectable = false, selected = [], onToggle, keyboard = false }: {
  runs: RunHeader[]
  compact?: boolean
  selectable?: boolean
  selected?: number[]
  onToggle?: (id: number) => void
  keyboard?: boolean
}) {
  const nav = useNavigate()
  const [active] = useListNav(runs.length, (i) => nav(`/runs/${runs[i].id}`, { viewTransition: true }), keyboard)
  return (
    <ScrollTable className={clsx(!compact && '[&_table]:min-w-[1140px] [&_table]:table-fixed')}>
      {!compact && (
        <colgroup>
          {selectable && <col className="w-10" />}
          <col className="w-16" />
          <col />
          <col className="w-44" />
          <col className="w-44" />
          <col className="w-44" />
          <col className="w-20" />
          <col className="w-20" />
          <col className="w-24" />
          <col className="w-28" />
        </colgroup>
      )}
      <thead>
        <tr className="whitespace-nowrap">
          {selectable && <th className="w-10"><span className="sr-only">Compare</span></th>}
          <th className="t-label">Run</th>
          <th className="t-label">What ran</th>
          {!compact && <th className="t-label">Connection</th>}
          {!compact && <th className="t-label">Questions · judge</th>}
          <th className="t-label text-right">Pass rate</th>
          {!compact && <th className="t-label text-right">Tool acc.</th>}
          <th className="t-label text-right">p95</th>
          <th className="t-label">Gate</th>
          {!compact && <th className="t-label whitespace-nowrap">Started</th>}
        </tr>
      </thead>
      <tbody>
        {runs.map((r, i) => {
          const sel = selected.includes(r.id)
          const heur = r.judge?.provider === 'heuristic'
          const name = r.variant_label || r.experiment
          return (
            <motion.tr key={r.id} data-kb-index={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i * 0.02, 0.3) }}
              className={clsx('transition-colors hover:bg-surface-2/60', active === i && 'kb-active', sel && 'bg-accent-wash/60')}>
              {selectable && (
                <td>
                  <Checkbox checked={sel} onChange={() => onToggle?.(r.id)} aria-label={`Select run ${r.id} to compare`}
                    disabled={!sel && selected.length >= 2} label={<span className="sr-only">Compare run {r.id}</span>} />
                </td>
              )}
              <td className="font-mono text-xs"><Link className="text-accent-ink hover:underline" to={`/runs/${r.id}`} viewTransition>#{r.id}</Link></td>
              <td>
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  <Link to={`/runs/${r.id}`} viewTransition className="text-ink hover:underline">{name}</Link>
                  {r.off_topic && <Badge tone="warn" title={`Asked ${r.off_topic}'s questions, so it is left out of trends`}>another chatbot's questions</Badge>}
                  {r.source !== 'live' && <Badge>{r.source === 'reevaluated' ? `re-graded #${r.parent_run_id}` : r.source}</Badge>}
                  <RunStatus status={r.status} done={r.progress_done} total={r.progress_total} />
                </div>
                {name !== r.experiment && <div className="truncate font-mono text-label text-ink-3" title={r.experiment}>{r.experiment}</div>}
              </td>
              {!compact && <td className="truncate text-ink-2" title={`${r.target} v${r.target_version}`}>{r.target} <span className="font-mono text-xs text-ink-3">v{r.target_version}</span></td>}
              {!compact && (
                <td className="whitespace-nowrap text-xs text-ink-2">
                  <span className="num font-mono">{questionsOf(r) ?? 'n/a'}</span> × <span className="num font-mono">{r.trials_per_case}</span>
                  {' '}{heur ? <Badge tone="heuristic">heuristic</Badge> : <span className="text-ink-3">{r.judge ? r.judge.model : 'no judge'}</span>}
                </td>
              )}
              <td className="whitespace-nowrap text-right">
                <span className="inline-flex items-center justify-end gap-2.5">
                  {!compact && <PassBar value={r.metrics?.overall_pass_rate} ci={r.overall_ci} heuristic={heur} muted={!!r.off_topic} />}
                  <span className="num inline-block min-w-12 font-mono">{pct(r.metrics?.overall_pass_rate)}</span>
                </span>
              </td>
              {!compact && <td className="num text-right font-mono text-ink-2">{pct(r.metrics?.tool_accuracy)}</td>}
              <td className="num text-right font-mono text-ink-2">{ms(r.metrics?.p95_latency_ms)}</td>
              <td>{r.gate_status ? <StatusBadge status={r.gate_status} /> : <span className="text-xs text-ink-3">-</span>}</td>
              {!compact && <td className="whitespace-nowrap text-xs text-ink-3">{when(r.started_at ?? r.created_at)}</td>}
            </motion.tr>
          )
        })}
      </tbody>
    </ScrollTable>
  )
}
