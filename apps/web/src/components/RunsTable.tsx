import clsx from 'clsx'
import { motion } from 'motion/react'
import { Link, useNavigate } from 'react-router-dom'
import { ms, pct, when } from '../lib/format'
import { useListNav } from '../lib/hotkeys'
import type { RunHeader } from '../lib/types'
import { Badge, RunStatus, StatusBadge, Table } from './ui'

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
    <Table>
      <thead>
        <tr>
          {selectable && <th className="w-8"><span className="sr-only">Compare</span></th>}
          <th>Run</th>
          <th>Name</th>
          {!compact && <th>Connection</th>}
          {!compact && <th>Cases / judge</th>}
          <th className="text-right">Pass rate</th>
          {!compact && <th className="text-right">Tool acc.</th>}
          <th className="text-right">p95</th>
          <th>Gate</th>
          {!compact && <th className="whitespace-nowrap">Started</th>}
        </tr>
      </thead>
      <tbody>
        {runs.map((r, i) => {
          const sel = selected.includes(r.id)
          const heur = r.judge?.provider === 'heuristic'
          return (
            <motion.tr key={r.id} data-kb-index={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i * 0.02, 0.3) }}
              className={clsx('hover:bg-surface-2/60', active === i && 'kb-active', sel && 'bg-accent-wash/60')}>
              {selectable && (
                <td>
                  <input type="checkbox" checked={sel} onChange={() => onToggle?.(r.id)} aria-label={`Select run ${r.id} to compare`}
                    disabled={!sel && selected.length >= 2} className="size-4 accent-[var(--accent)]" />
                </td>
              )}
              <td className="font-mono text-xs"><Link className="text-accent-ink hover:underline" to={`/runs/${r.id}`} viewTransition>#{r.id}</Link></td>
              <td className="max-w-80">
                <Link to={`/runs/${r.id}`} viewTransition className="hover:underline">{r.experiment}</Link>
                <span className="ml-1.5 inline-flex gap-1 align-middle">
                  {r.source !== 'live' && <Badge>{r.source === 'reevaluated' ? `re-graded #${r.parent_run_id}` : r.source}</Badge>}
                  <RunStatus status={r.status} done={r.progress_done} total={r.progress_total} />
                </span>
              </td>
              {!compact && <td className="max-w-56 truncate" title={r.variant_label}>{r.target} <span className="text-ink-3">v{r.target_version}</span></td>}
              {!compact && (
                <td className="whitespace-nowrap text-xs text-ink-2">
                  <span className="num">{r.n_cases ?? '?'}</span> x {r.trials_per_case}
                  <span className={clsx('ml-1.5 rounded px-1', heur ? 'hatched text-ink-2' : 'text-ink-3')}>{r.judge ? (heur ? 'heuristic' : r.judge.model) : 'no judge'}</span>
                </td>
              )}
              <td className={clsx('num text-right', heur && '')}>{pct(r.metrics?.overall_pass_rate)}</td>
              {!compact && <td className="num text-right">{pct(r.metrics?.tool_accuracy)}</td>}
              <td className="num text-right">{ms(r.metrics?.p95_latency_ms)}</td>
              <td>{r.gate_status ? <StatusBadge status={r.gate_status} /> : <span className="text-xs text-ink-3">-</span>}</td>
              {!compact && <td className="whitespace-nowrap text-xs text-ink-3">{when(r.started_at ?? r.created_at)}</td>}
            </motion.tr>
          )
        })}
      </tbody>
    </Table>
  )
}
