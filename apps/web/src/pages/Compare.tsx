import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PairedBars } from '../components/charts'
import { Badge, Card, Empty, ErrorState, Loading, Notice, PageHeader, Select, StatusBadge, Table } from '../components/ui'
import { api } from '../lib/api'
import { FAILURE_LABELS, ms, num, pct, relative, score, usd } from '../lib/format'
import type { CaseChange, Comparison, ComparisonRow, RunHeader } from '../lib/types'

const LOWER_BETTER = new Set(['latency', 'cost', 'count'])

export function fmtValue(row: Pick<ComparisonRow, 'unit'>, v: number | null): string {
  switch (row.unit) {
    case 'rate': return pct(v)
    case 'latency': return ms(v)
    case 'cost': return usd(v)
    case 'count': return num(v)
    default: return score(v)
  }
}

export function fmtDelta(row: ComparisonRow): string {
  if (row.delta === null) return 'n/a'
  if (row.unit === 'rate') return `${row.delta > 0 ? '+' : ''}${(row.delta * 100).toFixed(1)}pp`
  if (row.unit === 'score') return `${row.delta > 0 ? '+' : ''}${row.delta.toFixed(3)}`
  return relative(row.relative)
}

export function direction(row: ComparisonRow): 'better' | 'worse' | 'same' {
  if (row.delta === null || row.delta === 0) return 'same'
  const lower = LOWER_BETTER.has(row.unit)
  return (lower ? row.delta < 0 : row.delta > 0) ? 'better' : 'worse'
}

/** Plain-language reading of the paired interval. Never calls a difference "significant". */
export function reading(row: ComparisonRow): { text: string; tone: 'neutral' | 'good' | 'bad' } {
  if (row.delta === null) return { text: 'not available', tone: 'neutral' }
  if (!row.ci || row.ci.ci_low === null) return { text: row.unit === 'rate' ? 'no interval' : 'point estimate', tone: 'neutral' }
  if (!row.ci.excludes_zero) return { text: 'within noise', tone: 'neutral' }
  return { text: direction(row) === 'better' ? 'likely better' : 'likely worse', tone: direction(row) === 'better' ? 'good' : 'bad' }
}

export function MetricTable({ rows }: { rows: ComparisonRow[] }) {
  return (
    <Table>
      <thead>
        <tr><th>Metric</th><th className="text-right">Baseline</th><th className="text-right">Candidate</th><th className="text-right">Delta</th><th className="text-right">95% CI of delta (paired)</th><th>Reading</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const d = direction(r)
          const read = reading(r)
          const Icon = d === 'better' ? ArrowUpRight : d === 'worse' ? ArrowDownRight : Minus
          return (
            <tr key={r.metric} data-testid={`metric-${r.metric}`}>
              <td className="font-medium">{r.label}</td>
              <td className="num text-right">{fmtValue(r, r.baseline)}</td>
              <td className="num text-right">{fmtValue(r, r.candidate)}</td>
              <td className={clsx('num text-right font-medium', d === 'better' && 'text-good-ink', d === 'worse' && 'text-bad-ink')}>
                <span className="inline-flex items-center gap-1"><Icon className="size-3.5" aria-label={d} />{fmtDelta(r)}</span>
              </td>
              <td className="num whitespace-nowrap text-right text-xs text-ink-2">
                {r.ci && r.ci.ci_low !== null ? `${(r.ci.ci_low * 100).toFixed(1)} to ${(r.ci.ci_high! * 100).toFixed(1)}pp (n=${r.ci.n})` : '-'}
              </td>
              <td><Badge tone={read.tone}>{read.text}</Badge></td>
            </tr>
          )
        })}
      </tbody>
    </Table>
  )
}

function CaseList({ items, runId, kind }: { items: CaseChange[]; runId: number; kind: 'regression' | 'improvement' }) {
  if (!items.length) return <p className="text-[13px] text-ink-3">None.</p>
  return (
    <ul className="divide-y divide-line">
      {items.map((c) => (
        <li key={c.case_id} className="py-2">
          <div className="flex items-center gap-2 text-[13px]">
            <Link className="font-mono text-xs text-accent-ink hover:underline" to={`/runs/${runId}?tab=cases&case=${c.case_id}`}>{c.case_id}</Link>
            <span className="truncate">{c.title}</span>
            <Badge className="ml-auto">{c.category}</Badge>
          </div>
          <div className="num mt-0.5 text-xs text-ink-2">
            pass rate {pct(c.baseline_pass_rate, 0)} {'->'} <span className={kind === 'regression' ? 'text-bad-ink' : 'text-good-ink'}>{pct(c.candidate_pass_rate, 0)}</span>
            {kind === 'regression' && c.candidate_failure_types.length > 0 && <> - {c.candidate_failure_types.map((f) => FAILURE_LABELS[f] ?? f).join(', ')}</>}
          </div>
        </li>
      ))}
    </ul>
  )
}

export function ComparePage() {
  const [params, setParams] = useSearchParams()
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs') })
  const done = (runs.data ?? []).filter((r) => r.status === 'completed' || r.status === 'completed_with_errors')
  const baseline = Number(params.get('baseline')) || null
  const candidate = Number(params.get('candidate')) || null

  useEffect(() => {
    // Default: the newest completed run as candidate, the newest earlier run on the same dataset as baseline.
    if (!done.length || (baseline && candidate)) return
    const cand = candidate ? done.find((r) => r.id === candidate) : done[0]
    const base = done.find((r) => r.id !== cand?.id && r.dataset === cand?.dataset && r.id < (cand?.id ?? 0)) ?? done.find((r) => r.id !== cand?.id)
    if (cand && base) setParams({ baseline: String(base.id), candidate: String(cand.id) }, { replace: true })
  }, [done, baseline, candidate, setParams])

  const cmp = useQuery({
    queryKey: ['compare', baseline, candidate],
    queryFn: () => api.get<Comparison>(`/api/runs/compare?baseline=${baseline}&candidate=${candidate}`),
    enabled: !!baseline && !!candidate && baseline !== candidate,
  })

  const picker = (key: 'baseline' | 'candidate', value: number | null) => (
    <Select className="w-72" aria-label={key} value={value ?? ''} onChange={(e) => setParams((p) => { p.set(key, e.target.value); return p })}>
      <option value="">Choose a run...</option>
      {done.map((r) => <option key={r.id} value={r.id}>#{r.id} {r.experiment} ({r.target} v{r.target_version})</option>)}
    </Select>
  )

  return (
    <>
      <PageHeader
        title="Compare"
        description="Baseline vs candidate on the same cases. Deltas are paired by case; intervals come from resampling cases. A difference whose interval includes zero is reported as within noise."
      />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 text-xs text-ink-2"><span className="size-2.5 rounded-sm bg-series-1" aria-hidden />Baseline</span>
        {picker('baseline', baseline)}
        <span className="flex items-center gap-2 text-xs text-ink-2"><span className="size-2.5 rounded-sm bg-series-2" aria-hidden />Candidate</span>
        {picker('candidate', candidate)}
      </div>
      {runs.isLoading ? <Loading /> : done.length < 2 ? (
        <Empty title="Two completed runs are needed">Run a baseline and a candidate on the same dataset (<code>gaugelab seed --run</code> does this for the Acme demo).</Empty>
      ) : baseline === candidate ? <Notice tone="warn" title="Pick two different runs" /> : cmp.isLoading ? <Loading label="Comparing" /> : cmp.isError ? <ErrorState error={cmp.error} /> : cmp.data && <CompareView c={cmp.data} />}
    </>
  )
}

function CompareView({ c }: { c: Comparison }) {
  const mc = c.mcnemar
  return (
    <div className="space-y-5">
      {!c.same_dataset_content && (
        <Notice tone="warn" title="The two runs used different dataset content">Only the {c.n_shared_cases} case ids present in both are paired. Differences may come from the dataset, not the system.</Notice>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {[c.baseline_run, c.candidate_run].map((r, i) => (
          <div key={r.id} className={clsx('rounded-lg border bg-surface px-4 py-3', i === 0 ? 'border-series-1/40' : 'border-series-2/40')}>
            <div className="flex items-center gap-2 text-xs text-ink-3"><span className={clsx('size-2.5 rounded-sm', i === 0 ? 'bg-series-1' : 'bg-series-2')} />{i === 0 ? 'Baseline' : 'Candidate'} <Link className="font-mono text-accent-ink hover:underline" to={`/runs/${r.id}`}>#{r.id}</Link>{r.gate_status && <StatusBadge status={r.gate_status} />}</div>
            <div className="mt-1 text-[13px] font-medium">{r.target} v{r.target_version}</div>
            <div className="text-xs text-ink-2">{r.variant_label} - {r.n_cases} cases x {r.trials_per_case} trial(s) - judge {r.judge ? `${r.judge.provider}/${r.judge.model}` : 'none'}</div>
          </div>
        ))}
      </div>
      {[c.baseline_run, c.candidate_run].some((r) => r.judge?.provider === 'heuristic') && (
        <Notice title="Judge rows come from the heuristic judge">
          Rows marked (judge) were scored by word overlap with the reference, not by an LLM. They are a cheap signal for CI and
          do not fail trials on their own. Configure an LLM judge (local Ollama or your own key) for semantic grading.
        </Notice>
      )}
      <Card title={`Metrics (${c.n_shared_cases} paired cases)`} padded={false}>
        <MetricTable rows={c.metrics} />
        <div className="border-t border-line px-3 py-2 text-xs text-ink-2">
          Case outcomes (passed every trial): both pass {mc.both_pass}, only baseline {mc.only_baseline}, only candidate {mc.only_candidate}, both fail {mc.both_fail}.
          {' '}McNemar exact test on the {mc.only_baseline + mc.only_candidate} cases that changed: {mc.p_value === null ? 'n/a' : `p = ${mc.p_value.toFixed(3)}`}
          {' '}(how surprising this split would be if the two variants were equally good; it says nothing about how large the effect is).
        </div>
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={<span className="text-bad-ink">Regressed: passed more often on the baseline ({c.regressions.length})</span>}>
          <CaseList items={c.regressions} runId={c.candidate_run.id} kind="regression" />
        </Card>
        <Card title={<span className="text-good-ink">Improved: passed more often on the candidate ({c.improvements.length})</span>}>
          <CaseList items={c.improvements} runId={c.candidate_run.id} kind="improvement" />
        </Card>
      </div>
      <Card title="Pass rate by category">
        <PairedBars data={c.by_category.map((r) => ({ group: r.category, baseline: r.baseline, candidate: r.candidate, n: r.n }))} />
        <Table className="mt-3">
          <thead><tr><th>Category</th><th className="text-right">Cases</th><th className="text-right">Baseline</th><th className="text-right">Candidate</th><th className="text-right">Delta</th></tr></thead>
          <tbody>
            {c.by_category.map((r) => (
              <tr key={r.category}>
                <td>{r.category}</td><td className="num text-right">{r.n}</td><td className="num text-right">{pct(r.baseline)}</td><td className="num text-right">{pct(r.candidate)}</td>
                <td className={clsx('num text-right font-medium', (r.delta ?? 0) > 0 && 'text-good-ink', (r.delta ?? 0) < 0 && 'text-bad-ink')}>{r.delta === null ? 'n/a' : `${r.delta > 0 ? '+' : ''}${(r.delta * 100).toFixed(1)}pp`}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="mt-2 text-xs text-ink-3">Small categories move a lot from one case: read the case count before the delta.</p>
      </Card>
      {c.score_changes.length > 0 && (
        <Card title={`Material score changes (|delta| >= 0.25, ${c.score_changes.length})`} padded={false}>
          <Table>
            <thead><tr><th>Case</th><th>Evaluator</th><th className="text-right">Baseline</th><th className="text-right">Candidate</th></tr></thead>
            <tbody>{c.score_changes.slice(0, 50).map((s) => <tr key={s.case_id + s.evaluator_id}><td className="font-mono text-xs">{s.case_id}</td><td>{s.evaluator_id}</td><td className="num text-right">{s.baseline.toFixed(3)}</td><td className="num text-right">{s.candidate.toFixed(3)}</td></tr>)}</tbody>
          </Table>
        </Card>
      )}
    </div>
  )
}
