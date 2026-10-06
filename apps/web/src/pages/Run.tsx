import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { Download, GitCompareArrows, RotateCcw, Square } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CountBars, IntervalBar } from '../components/charts'
import { TraceViewer } from '../components/TraceViewer'
import { Badge, Button, Card, Empty, ErrorState, Field, Json, Loading, Notice, PageHeader, Select, Stat, StatusBadge, Table, Tabs } from '../components/ui'
import { api, qs } from '../lib/api'
import { duration, FAILURE_LABELS, ms, num, pct, score, usd, when } from '../lib/format'
import type { EvaluatorInfo, Gate, GateResult, Reliability, RunDetail, RunHeader, RunSummary, TrialDetail, TrialRow } from '../lib/types'

type RTab = 'summary' | 'cases' | 'failures' | 'metrics' | 'traces' | 'config'

export function RunPage() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as RTab) ?? 'summary'
  const setTab = (t: RTab) => setParams((p) => { p.set('tab', t); return p })
  const qc = useQueryClient()
  const run = useQuery({
    queryKey: ['run', id],
    queryFn: () => api.get<RunDetail>(`/api/runs/${id}`),
    refetchInterval: (q) => (q.state.data && ['queued', 'running'].includes(q.state.data.status) ? 1500 : false),
  })
  const cancel = useMutation({ mutationFn: () => api.post(`/api/runs/${id}/cancel`), onSuccess: () => qc.invalidateQueries({ queryKey: ['run', id] }) })
  if (run.isLoading) return <Loading />
  if (run.isError) return <ErrorState error={run.error} />
  const r = run.data!
  const active = r.status === 'queued' || r.status === 'running'
  const s = r.summary

  return (
    <>
      <PageHeader
        title={<span className="flex items-center gap-2">Run <span className="font-mono">#{r.id}</span> <span className="font-normal text-ink-2">{r.experiment}</span></span>}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Target <Link className="font-medium hover:underline" to={`/targets`}>{r.target}</Link> v{r.target_version}{r.variant_label && <span className="text-ink-3"> ({r.variant_label})</span>}</span>
            <span>Dataset {r.dataset} v{r.dataset_version}</span>
            <span>{r.n_cases ?? '?'} cases x {r.trials_per_case} trial(s)</span>
            <span>Judge: {r.judge ? `${r.judge.provider}/${r.judge.model}` : 'none'}</span>
            {r.source !== 'live' && <Badge tone="info">{r.source}{r.parent_run_id ? ` from #${r.parent_run_id}` : ''}</Badge>}
          </span>
        }
        actions={
          <>
            <StatusBadge status={r.status} />
            {active && <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}><Square className="size-3.5" /> Cancel</Button>}
            {!active && <Link className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-[13px] hover:bg-surface-2" to={`/compare?candidate=${r.id}`}><GitCompareArrows className="size-3.5" /> Compare</Link>}
            {!active && <a className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-[13px] hover:bg-surface-2" href={`/api/runs/${r.id}/export?format=json`}><Download className="size-3.5" /> JSON</a>}
          </>
        }
      />
      {active && <Progress r={r} />}
      {r.error && <div className="mb-4"><Notice tone="bad" title="Run failed">{r.error}</Notice></div>}
      {r.stop_reason === 'budget' && <div className="mb-4"><Notice tone="warn" title="Stopped at the cost budget">Trials after the budget was reached were not run and are marked cancelled.</Notice></div>}
      <Tabs
        tabs={[
          { id: 'summary', label: 'Summary' },
          { id: 'cases', label: 'Cases' },
          { id: 'failures', label: `Failures${s ? ` (${s.failed_trials})` : ''}` },
          { id: 'metrics', label: 'Metrics' },
          { id: 'traces', label: 'Traces' },
          { id: 'config', label: 'Config' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="mt-4">
        {!s ? <Loading label="Waiting for the first results" /> : (
          <>
            {tab === 'summary' && <SummaryTab r={r} s={s} />}
            {tab === 'cases' && <CasesTab runId={r.id} />}
            {tab === 'failures' && <FailuresTab runId={r.id} s={s} />}
            {tab === 'metrics' && <MetricsTab s={s} />}
            {tab === 'traces' && <TracesTab runId={r.id} />}
            {tab === 'config' && <ConfigTab r={r} />}
          </>
        )}
      </div>
    </>
  )
}

function Progress({ r }: { r: RunHeader }) {
  const p = r.progress_total ? r.progress_done / r.progress_total : 0
  return (
    <div className="mb-4 rounded-lg border border-line bg-surface p-3">
      <div className="mb-1.5 flex justify-between text-xs text-ink-2"><span>{r.status === 'queued' ? 'Queued' : 'Running'}: {r.progress_done} of {r.progress_total} trials</span><span className="num">{pct(p, 0)}</span></div>
      <div className="h-1.5 rounded-full bg-surface-2"><div className="h-full rounded-full bg-series-1 transition-all" style={{ width: `${p * 100}%` }} /></div>
    </div>
  )
}

function GateCard({ r }: { r: RunDetail }) {
  const qc = useQueryClient()
  const gates = useQuery({ queryKey: ['gates'], queryFn: () => api.get<Gate[]>('/api/gates') })
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs') })
  const [gateId, setGateId] = useState<number | ''>('')
  const [baseline, setBaseline] = useState<number | ''>('')
  const apply = useMutation({
    mutationFn: () => api.post<GateResult>(`/api/runs/${r.id}/gate`, { gate_id: gateId || gates.data?.[0]?.id, baseline_run_id: baseline || null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run', String(r.id)] }),
  })
  const latest = r.gate_results[0]
  return (
    <Card title="Regression gate" actions={latest && <StatusBadge status={latest.status} />}>
      {latest ? (
        <div className="space-y-1.5">
          {latest.results.gates.map((g) => (
            <div key={g.gate} className="flex items-center justify-between gap-2 text-[13px]">
              <span className="flex items-center gap-2"><StatusBadge status={g.status} /><code className="text-xs">{g.gate}</code></span>
              <span className="num text-xs text-ink-2">
                {g.value === null ? (g.reason ?? 'n/a') : g.kind === 'relative'
                  ? `${g.value <= 0 ? `up ${pp1(-g.value)}` : `down ${pp1(g.value)}`} vs baseline (max drop ${pp1(g.limit)})`
                  : `${fmtMetric(g.metric, g.value)} ${g.rule === 'min' ? '>=' : '<='} ${fmtMetric(g.metric, g.limit)}`}
              </span>
            </div>
          ))}
          {latest.baseline_run_id && <p className="pt-1 text-xs text-ink-3">Relative to baseline run <Link className="underline" to={`/runs/${latest.baseline_run_id}`}>#{latest.baseline_run_id}</Link>.</p>}
          {latest.status === 'INCOMPLETE' && <p className="text-xs text-warn-ink">Some gates could not be evaluated, so this run is not a PASS.</p>}
        </div>
      ) : <p className="text-[13px] text-ink-3">No gate applied yet.</p>}
      <div className="mt-3 grid grid-cols-[1fr_1fr_auto] items-end gap-2 border-t border-line pt-3">
        <Field label="Gate"><Select value={gateId} onChange={(e) => setGateId(e.target.value ? Number(e.target.value) : '')}>{(gates.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field>
        <Field label="Baseline run"><Select value={baseline} onChange={(e) => setBaseline(e.target.value ? Number(e.target.value) : '')}><option value="">None</option>{(runs.data ?? []).filter((x) => x.id !== r.id).map((x) => <option key={x.id} value={x.id}>#{x.id} {x.experiment}</option>)}</Select></Field>
        <Button disabled={!gates.data?.length} loading={apply.isPending} onClick={() => apply.mutate()}>Apply</Button>
      </div>
      {apply.isError && <div className="mt-2"><ErrorState error={apply.error} /></div>}
    </Card>
  )
}

const pp1 = (v: number) => `${(v * 100).toFixed(1)}pp`
function fmtMetric(metric: string, v: number): string {
  if (metric.includes('latency')) return ms(v)
  if (metric.includes('cost')) return usd(v)
  if (metric.includes('tokens')) return num(v)
  if (metric.endsWith('.mean')) return score(v)
  return pct(v)
}

function SummaryTab({ r, s }: { r: RunDetail; s: RunSummary }) {
  const rel = Object.values(s.reliability).filter((x): x is Reliability => !Array.isArray(x) && typeof x === 'object')
  const flaky = (s.reliability.flaky_cases as string[] | undefined) ?? []
  const tel = s.telemetry
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="Overall pass rate" value={pct(s.overall.value)} sub={s.overall.ci_low !== null ? `95% CI ${pct(s.overall.ci_low, 0)} to ${pct(s.overall.ci_high, 0)}, n=${s.overall.n}` : `n=${s.overall.n}`} />
        <Stat label="Tool accuracy" value={pct(s.metrics.tool_accuracy)} sub="selection + arguments + forbidden" />
        <Stat label="p50 / p95 latency" value={ms(s.metrics.p95_latency_ms)} sub={`p50 ${ms(s.metrics.p50_latency_ms)}, n=${tel.latency_n}`} />
        <Stat label="Tokens / query" value={num(s.metrics.average_total_tokens)} sub={tel.tokens_n ? `reported on ${tel.tokens_n} trials` : 'not reported by target'} />
        <Stat label="Est. target cost / query" value={usd(s.metrics.average_cost_usd)} sub={tel.target_cost_n ? 'estimated from the price table' : 'unknown: no usage or no price'} />
        <Stat label="Est. judge cost (total)" value={usd(s.metrics.total_judge_cost_usd)} sub={r.judge ? `${r.judge.provider}/${r.judge.model}` : 'no judge'} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <GateCard r={r} />
        <Card title="Repeated trials">
          {s.trials_per_case < 2 ? (
            <p className="text-[13px] text-ink-3">One trial per case. Run 3 or more trials to measure consistency.</p>
          ) : (
            <>
              <Table>
                <thead><tr><th>k</th><th className="text-right">pass@k</th><th className="text-right">pass^k</th><th className="text-right">Cases</th></tr></thead>
                <tbody>{rel.map((x) => <tr key={x.k}><td className="num">{x.k}</td><td className="num text-right">{pct(x.pass_at_k)}</td><td className="num text-right">{pct(x.pass_hat_k)}</td><td className="num text-right">{x.n_cases}</td></tr>)}</tbody>
              </Table>
              <dl className="mt-3 space-y-1 text-xs text-ink-2">
                <div><dt className="inline font-medium text-ink">pass@k</dt> <dd className="inline">- can the system succeed at least once across k attempts?</dd></div>
                <div><dt className="inline font-medium text-ink">pass^k</dt> <dd className="inline">- is it consistently successful across all k attempts?</dd></div>
              </dl>
              {flaky.length > 0 && <p className="mt-2 text-xs text-warn-ink">Flaky ({flaky.length}): {flaky.map((c, i) => <span key={c}>{i > 0 && ', '}<Link className="underline" to={`?tab=cases&case=${c}`}>{c}</Link></span>)}</p>}
            </>
          )}
        </Card>
      </div>
      <Card title="By category" padded={false}>
        <Table>
          <thead><tr><th>Category</th><th className="text-right">Pass rate</th><th className="text-right">Cases</th></tr></thead>
          <tbody>{Object.entries(s.by_category).map(([c, v]) => <tr key={c}><td><Link className="hover:underline" to={`?tab=cases&category=${c}`}>{c}</Link></td><td className="num text-right">{pct(v.pass_rate)}</td><td className="num text-right">{v.n}</td></tr>)}</tbody>
        </Table>
      </Card>
      <p className="text-xs text-ink-3">Started {when(r.started_at)}, took {duration(r.started_at, r.finished_at)}. Rates are averaged per case first (trials of one case are repeats, not new evidence); intervals resample cases.</p>
    </div>
  )
}

function useTrials(runId: number, filters: Record<string, string | undefined>) {
  return useQuery({ queryKey: ['trials', runId, filters], queryFn: () => api.get<TrialRow[]>(`/api/runs/${runId}/trials${qs(filters)}`) })
}

export function TrialTable({ rows }: { rows: TrialRow[] }) {
  return (
    <Table>
      <thead><tr><th>Case</th><th>Trial</th><th>Status</th><th>Question</th><th>Failed checks</th><th className="text-right">Latency</th></tr></thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.id} className="align-top hover:bg-surface-2/60">
            <td className="whitespace-nowrap font-mono text-xs"><Link className="text-accent-ink hover:underline" to={`/trials/${t.id}`}>{t.case_id}</Link></td>
            <td className="num text-ink-3">{t.trial_index + 1}</td>
            <td><StatusBadge status={t.status} /></td>
            <td className="max-w-xs"><div className="truncate">{t.question ?? t.title}</div><div className="truncate text-xs text-ink-3">{t.answer}</div></td>
            <td><div className="flex flex-wrap gap-1">{t.failed_evaluators.map((e) => <Badge key={e} tone="bad">{e}</Badge>)}{t.failure_override && <Badge tone="info">annotated</Badge>}</div></td>
            <td className="num text-right text-xs">{ms(t.latency_ms)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

function CasesTab({ runId }: { runId: number }) {
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const category = params.get('category') ?? ''
  const caseId = params.get('case') ?? ''
  const q = useTrials(runId, { status: status || undefined, category: category || undefined })
  const rows = (q.data ?? []).filter((t) => !caseId || t.case_id === caseId)
  const cats = useMemo(() => [...new Set((q.data ?? []).map((t) => t.category).filter(Boolean))] as string[], [q.data])
  const set = (k: string, v: string) => setParams((p) => { if (v) p.set(k, v); else p.delete(k); return p })
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select className="w-40" value={status} onChange={(e) => set('status', e.target.value)} aria-label="Status filter">
          <option value="">All statuses</option>{['passed', 'failed', 'error', 'unscored', 'cancelled'].map((x) => <option key={x}>{x}</option>)}
        </Select>
        <Select className="w-48" value={category} onChange={(e) => set('category', e.target.value)} aria-label="Category filter">
          <option value="">All categories</option>{cats.map((c) => <option key={c}>{c}</option>)}
        </Select>
        {caseId && <Button size="sm" variant="ghost" onClick={() => set('case', '')}>Case {caseId} x</Button>}
        <span className="text-xs text-ink-3">{rows.length} trials</span>
      </div>
      <Card padded={false}>{q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} /> : <TrialTable rows={rows} />}</Card>
    </div>
  )
}

function FailuresTab({ runId, s }: { runId: number; s: RunSummary }) {
  const [params, setParams] = useSearchParams()
  const selected = params.get('failure')
  const q = useTrials(runId, { failure_type: selected ?? undefined })
  const data = Object.entries(s.failures).map(([key, value]) => ({ key, label: FAILURE_LABELS[key] ?? key, value }))
  if (data.length === 0) return <Empty title="No failures">Every scored trial passed its gating checks. Check the Metrics tab for checks that were not applicable or not evaluated.</Empty>
  return (
    <div className="grid gap-5 xl:grid-cols-[400px_minmax(0,1fr)]">
      <Card title={`${s.failed_trials} failed trial(s) by type`}>
        <p className="mb-2 text-xs text-ink-3">A trial counts once per failure type it shows. Click a bar to filter.</p>
        <CountBars data={data} selected={selected} onSelect={(k) => setParams((p) => { if (selected === k) p.delete('failure'); else p.set('failure', k); return p })} />
        <Table className="mt-2">
          <tbody>{data.map((d) => <tr key={d.key}><td><button className={clsx('hover:underline', selected === d.key && 'font-semibold')} onClick={() => setParams((p) => { p.set('failure', d.key); return p })}>{d.label}</button></td><td className="num text-right">{d.value}</td></tr>)}</tbody>
        </Table>
      </Card>
      <Card title={selected ? `${FAILURE_LABELS[selected] ?? selected}` : 'All failed trials'} padded={false} actions={selected && <Button size="sm" variant="ghost" onClick={() => setParams((p) => { p.delete('failure'); return p })}>Clear filter</Button>}>
        {q.isLoading ? <Loading /> : <TrialTable rows={(q.data ?? []).filter((t) => t.status === 'failed' || t.status === 'error')} />}
      </Card>
    </div>
  )
}

function MetricsTab({ s }: { s: RunSummary }) {
  const evs = useQuery({ queryKey: ['evaluators'], queryFn: () => api.get<{ evaluators: EvaluatorInfo[] }>('/api/evaluators') })
  const info = Object.fromEntries((evs.data?.evaluators ?? []).map((e) => [e.id, e]))
  return (
    <Card padded={false}>
      <Table>
        <thead><tr><th>Evaluator</th><th>Kind</th><th className="text-right">Pass rate</th><th>95% CI</th><th className="text-right">Mean score</th><th className="text-right">Decided</th><th>Not applicable / not evaluated / unknown / error</th><th>Version</th></tr></thead>
        <tbody>
          {Object.entries(s.evaluators).map(([id, m]) => (
            <tr key={id}>
              <td><span className="font-medium">{info[id]?.name ?? id}</span>{!m.gating && <span className="ml-1 text-xs text-ink-3">(diagnostic)</span>}{info[id]?.calibration && <div className="text-xs text-ink-3">{info[id].calibration!.status}</div>}</td>
              <td><Badge>{m.kind}</Badge></td>
              <td className="num text-right">{pct(m.pass_rate)}</td>
              <td><IntervalBar value={m.pass_rate} low={m.ci_low} high={m.ci_high} /></td>
              <td className="num text-right">{score(m.mean_score)}</td>
              <td className="num text-right">{m.n_decided}</td>
              <td className="num text-xs text-ink-3">{m.counts.not_applicable ?? 0} / {m.counts.not_evaluated ?? 0} / {m.counts.unknown ?? 0} / {m.counts.error ?? 0}</td>
              <td className="font-mono text-xs text-ink-3">{m.version}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="border-t border-line px-3 py-2 text-xs text-ink-3">Pass rates count only decided trials (pass or fail). "Not applicable" means the case does not ask for that check; "not evaluated" means the target did not report what it needs. Neither is turned into a number.</p>
    </Card>
  )
}

function TracesTab({ runId }: { runId: number }) {
  const q = useTrials(runId, {})
  const [sel, setSel] = useState<number | null>(null)
  const trial = useQuery({ queryKey: ['trial', sel], queryFn: () => api.get<TrialDetail>(`/api/trials/${sel}`), enabled: sel !== null })
  const nav = useNavigate()
  return (
    <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Card title="Trials" padded={false}>
        <ul className="scroll-thin max-h-[640px] overflow-y-auto">
          {(q.data ?? []).filter((t) => t.status !== 'cancelled').map((t) => (
            <li key={t.id}>
              <button onClick={() => setSel(t.id)} className={clsx('flex w-full items-center gap-2 border-b border-line px-3 py-1.5 text-left text-xs hover:bg-surface-2', sel === t.id && 'bg-surface-2')}>
                <StatusBadge status={t.status} /><span className="font-mono">{t.case_id}</span><span className="text-ink-3">#{t.trial_index + 1}</span><span className="num ml-auto text-ink-3">{ms(t.latency_ms)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={trial.data ? <>Trace - <span className="font-mono">{trial.data.case_id}</span> trial {trial.data.trial_index + 1}</> : 'Trace'} actions={sel && <Button size="sm" onClick={() => nav(`/trials/${sel}`)}>Open trial</Button>}>
        {sel === null ? <p className="text-[13px] text-ink-3">Pick a trial to see its execution trace.</p> : trial.isLoading ? <Loading /> : trial.data?.trace ? <TraceViewer spans={trial.data.trace.spans} /> : <p className="text-[13px] text-ink-3">No trace stored.</p>}
      </Card>
    </div>
  )
}

function ConfigTab({ r }: { r: RunDetail }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const reeval = useMutation({
    mutationFn: () => api.post<RunHeader>(`/api/runs/${r.id}/reevaluate`, {}),
    onSuccess: (n) => { qc.invalidateQueries({ queryKey: ['runs'] }); nav(`/runs/${n.id}`) },
  })
  return (
    <div className="space-y-4">
      <Card title="Re-evaluate stored results" actions={<Button size="sm" loading={reeval.isPending} onClick={() => reeval.mutate()}><RotateCcw className="size-3.5" /> Re-run evaluators</Button>}>
        <p className="text-[13px] text-ink-2">Grade the stored answers again, without calling the target: useful after changing a rubric, a judge model or a threshold. The result is a new run linked to this one. To change evaluators or judge first, use <code>POST /api/runs/{r.id}/reevaluate</code> or the CLI.</p>
        {reeval.isError && <div className="mt-2"><ErrorState error={reeval.error} /></div>}
      </Card>
      <Card title="Snapshot (everything this run used)">
        <p className="mb-2 text-xs text-ink-3">Target configuration and version, dataset version and content hash, evaluator versions, judge provider/model/rubric hashes, and the experiment settings, frozen at launch.</p>
        <Json value={r.snapshot} maxHeight={640} />
      </Card>
    </div>
  )
}
