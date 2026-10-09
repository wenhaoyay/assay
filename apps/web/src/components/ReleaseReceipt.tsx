// The slip a passed (or failed) gate hands you: the rules, the figures, the run's fingerprint and
// the stamp. Shown when a run finishes and on the Gates page; prints cleanly.
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { label as metricLabel, ms, pct, when } from '../lib/format'
import type { GateCheck, RunDetail } from '../lib/types'
import { Fingerprint, Receipt, ReceiptLine, type Cell } from './instrument'
import { Button } from './ui'
import { Stamp } from './viz'

const LOWER_IS_BETTER = /latency|_ms$|cost|tokens/
const NAMES: Record<string, string> = {
  overall_pass_rate: 'Pass rate', tool_accuracy: 'Tool accuracy', must_mention: 'Must-mention',
  'recall_at_k.mean': 'Search recall', recall_at_k: 'Search recall', p95_latency_ms: 'p95 speed',
  p50_latency_ms: 'p50 speed', average_cost_usd: 'Cost per answer', average_total_tokens: 'Tokens per answer',
}
const metricName = (m: string) => NAMES[m] ?? metricLabel(m.replace(/\.mean$/, ''))

/** A rule's value as the reader thinks of it. Regression rules store how much WORSE the run got;
 *  show the change itself instead (+23.6pp is better for a rate, +120ms worse for speed). */
function checkValue(c: GateCheck): string {
  if (c.value === null || c.value === undefined) return 'n/a'
  const timeLike = /latency|_ms$/.test(c.metric)
  if (c.kind === 'relative') {
    const change = LOWER_IS_BETTER.test(c.metric) ? c.value : -c.value
    const sign = change >= 0 ? '+' : '−'
    return timeLike ? `${sign}${ms(Math.abs(change))}` : `${sign}${Math.abs(change * 100).toFixed(1)} pp`
  }
  return timeLike ? ms(c.value) : pct(c.value, 0)
}

export function ReleaseReceipt({ run, className }: { run: RunDetail; className?: string }) {
  const gate = run.gate_results?.[0]
  const fp = useQuery({
    queryKey: ['fingerprint', run.id],
    queryFn: () => api.get<{ case_id: string; status: string; title: string }[]>(`/api/runs/${run.id}/trials`),
    select: (rows): Cell[] => {
      const by = new Map<string, Cell>()
      for (const r of rows) {
        const c = by.get(r.case_id) ?? { id: r.case_id, passed: 0, total: 0, title: r.title }
        if (r.status === 'passed' || r.status === 'failed' || r.status === 'error') {
          c.total += 1
          c.passed += r.status === 'passed' ? 1 : 0
        }
        by.set(r.case_id, c)
      }
      return [...by.values()]
    },
  })
  if (!gate) return null
  const checks = gate.results?.gates ?? []
  const ok = checks.filter((c) => c.status === 'PASS').length
  return (
    <Receipt title="Release receipt" sub={`Assay · ${run.experiment} · ${when(run.finished_at ?? run.created_at)}`} className={className}>
      <ReceiptLine label="Chatbot" value={run.target} />
      <ReceiptLine label="Version" value={run.variant_label || `v${run.target_version}`} />
      <ReceiptLine label="Run" value={`#${run.id}${gate.baseline_run_id ? ` vs #${gate.baseline_run_id}` : ''}`} />
      <ReceiptLine label="Questions" value={`${run.n_cases ?? '?'} × ${run.trials_per_case}`} />
      <hr />
      {checks.map((c, i) => (
        <ReceiptLine key={i} label={`${metricName(c.metric)}${c.kind === 'relative' ? ' vs baseline' : ''}`}
          value={`${checkValue(c)} ${c.status === 'PASS' ? '✓' : c.status === 'FAIL' ? '✕' : '·'}`} />
      ))}
      <hr />
      {fp.data && <div className="my-2.5"><Fingerprint cells={fp.data} size="sm" /></div>}
      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-ink-3">{ok} of {checks.length} rules</span>
        {gate.status === 'PASS' || gate.status === 'FAIL' ? <Stamp status={gate.status} runId={run.id} /> : null}
      </div>
      <div className="no-print mt-4 flex gap-2 font-sans">
        <Button size="sm" onClick={() => navigator.clipboard?.writeText(`${location.origin}/runs/${run.id}`)}>Copy link</Button>
        <Button size="sm" onClick={() => window.print()}>Print</Button>
      </div>
    </Receipt>
  )
}
