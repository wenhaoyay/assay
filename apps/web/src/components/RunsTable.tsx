import { Link } from 'react-router-dom'
import { ms, pct, when } from '../lib/format'
import type { RunHeader } from '../lib/types'
import { StatusBadge, Table } from './ui'

export function RunsTable({ runs, compact = false }: { runs: RunHeader[]; compact?: boolean }) {
  return (
    <Table>
      <thead>
        <tr>
          <th>Run</th>
          <th>Experiment</th>
          {!compact && <th>Target</th>}
          {!compact && <th>Dataset</th>}
          <th>Status</th>
          <th className="text-right">Pass rate</th>
          {!compact && <th className="text-right">Tool acc.</th>}
          <th className="text-right">p95</th>
          <th>Gate</th>
          {!compact && <th>Started</th>}
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr key={r.id} className="hover:bg-surface-2/60">
            <td className="font-mono text-xs"><Link className="text-accent-ink hover:underline" to={`/runs/${r.id}`}>#{r.id}</Link></td>
            <td>
              <Link to={`/runs/${r.id}`} className="hover:underline">{r.experiment}</Link>
              {r.source !== 'live' && <span className="ml-1.5 text-xs text-ink-3">({r.source})</span>}
            </td>
            {!compact && <td className="max-w-56 truncate" title={r.variant_label}>{r.target} <span className="text-ink-3">v{r.target_version}</span></td>}
            {!compact && <td>{r.dataset} <span className="text-ink-3">v{r.dataset_version}</span></td>}
            <td>
              <StatusBadge status={r.status} />
              {r.status === 'running' && <span className="num ml-2 text-xs text-ink-3">{r.progress_done}/{r.progress_total}</span>}
            </td>
            <td className="num text-right">{pct(r.metrics?.overall_pass_rate)}</td>
            {!compact && <td className="num text-right">{pct(r.metrics?.tool_accuracy)}</td>}
            <td className="num text-right">{ms(r.metrics?.p95_latency_ms)}</td>
            <td>{r.gate_status ? <StatusBadge status={r.gate_status} /> : <span className="text-xs text-ink-3">-</span>}</td>
            {!compact && <td className="text-xs text-ink-3">{when(r.started_at ?? r.created_at)}</td>}
          </tr>
        ))}
      </tbody>
    </Table>
  )
}
