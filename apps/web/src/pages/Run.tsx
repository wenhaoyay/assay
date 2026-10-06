import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ChevronRight, GitCompareArrows, RotateCcw, Search, Square } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CountBars, IntervalBar, PairedBars } from '../components/charts'
import { ShareMenu } from '../components/Share'
import { TraceViewer } from '../components/TraceViewer'
import { LiveGrid, Stamp, StagePipeline } from '../components/viz'
import {
  Badge, Button, Card, Consistency, DotStrip, Empty, ErrorState, Explain, Field, Input, Json, Loading, Notice, PageHeader,
  PageSkeleton, ProgressBar, Segmented, Select, Stat, StatusBadge, Table, Tabs, Term, linkButton,
} from '../components/ui'
import { api, qs } from '../lib/api'
import { whereLabel } from '../lib/models'
import { useCrumbs } from '../lib/crumbs'
import { duration, FAILURE_LABELS, ms, num, pct, score, usd, when } from '../lib/format'
import { useHotkey, useListNav } from '../lib/hotkeys'
import { groupByCase, type CaseGroup } from '../lib/trials'
import type { EvaluatorInfo, Gate, GateResult, ProviderConfig, Reliability, RunDetail, RunHeader, RunSummary, Stage, TrialDetail, TrialRow } from '../lib/types'

type RTab = 'summary' | 'cases' | 'failures' | 'metrics' | 'traces' | 'config'
const TABS: RTab[] = ['summary', 'cases', 'failures', 'metrics', 'traces', 'config']

function usePreviousComparable(r: RunHeader | undefined) {
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs?limit=300'), enabled: !!r })
  if (!r || !runs.data) return null
  return runs.data.find((x) => x.id < r.id && x.comparability_key === r.comparability_key && (x.status === 'completed' || x.status === 'completed_with_errors')) ?? null
}

export function RunPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as RTab) ?? 'summary'
  const setTab = (t: RTab) => setParams((p) => { p.set('tab', t); return p })
  const qc = useQueryClient()
  const run = useQuery({
    queryKey: ['run', id],
    queryFn: () => api.get<RunDetail>(`/api/runs/${id}`),
    refetchInterval: (q) => (q.state.data && ['queued', 'running'].includes(q.state.data.status) ? 1500 : false),
  })
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<{ id: number; name: string }[]>('/api/projects') })
  const cancel = useMutation({ mutationFn: () => api.post(`/api/runs/${id}/cancel`), onSuccess: () => qc.invalidateQueries({ queryKey: ['run', id] }) })
  const prev = usePreviousComparable(run.data)
  const project = projects.data?.find((p) => p.id === run.data?.project_id)
  useCrumbs([
    ...(project ? [{ label: project.name, to: `/p/${project.id}` }] : [{ label: 'Runs', to: '/runs' }]),
    { label: `Run #${id}` },
  ], `run-${id}-${project?.name}`)

  useHotkey(["1", "2", "3", "4", "5", "6"], (ev) => setTab(TABS[Number(ev.key) - 1]))
  useHotkey('c', () => nav(prev ? `/compare?baseline=${prev.id}&candidate=${id}` : `/compare?candidate=${id}`, { viewTransition: true }), !!run.data)

  if (run.isLoading) return <PageSkeleton />
  if (run.isError) return <ErrorState error={run.error} />
  const r = run.data!
  const active = r.status === 'queued' || r.status === 'running'
  const s = r.summary
  const heur = r.judge?.provider === 'heuristic'

  return (
    <>
      <PageHeader
        eyebrow={<span className="font-mono">Run #{r.id}</span>}
        title={<span style={{ viewTransitionName: `run-title-${r.id}` }}>{r.experiment}</span>}
        description={
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Meta label="Connection"><Link className="font-medium hover:underline" to={r.target_id ? `/targets/${r.target_id}` : '/targets'}>{r.target}</Link> v{r.target_version}</Meta>
            {r.variant_label && <Meta label="Variant">{r.variant_label}</Meta>}
            <Meta label="Dataset">{r.dataset_id ? <Link className="hover:underline" to={`/datasets/${r.dataset_id}`}>{r.dataset}</Link> : r.dataset} v{r.dataset_version}</Meta>
            <Meta label="Size"><span className="num">{r.n_cases ?? '?'} cases x {r.trials_per_case}</span>{r.case_filter && ' (reduced)'}</Meta>
            <Meta label="Judge" hatched={heur}>{r.judge ? (heur ? <Term k="heuristic">heuristic</Term> : `${r.judge.provider}/${r.judge.model}`) : 'none'}</Meta>
            {r.source !== 'live' && <Meta label="Source">{r.source === 'reevaluated' ? <>re-graded from <Link className="underline" to={`/runs/${r.parent_run_id}`}>#{r.parent_run_id}</Link></> : r.source}</Meta>}
            {r.status !== 'completed' && <StatusBadge status={r.status} />}
          </div>
        }
        actions={
          <>
            {active && <Button variant="danger" loading={cancel.isPending} onClick={() => cancel.mutate()}><Square className="size-3.5" /> Cancel</Button>}
            {!active && <Link className={linkButton()} to={prev ? `/compare?baseline=${prev.id}&candidate=${r.id}` : `/compare?candidate=${r.id}`} viewTransition title="Compare (C)">
              <GitCompareArrows className="size-3.5" /> {prev ? `Compare with #${prev.id}` : 'Compare'}</Link>}
            {!active && <ShareMenu runId={r.id} baselineId={prev?.id} />}
          </>
        }
      />
      {active && <LiveRun r={r} />}
      {r.error && <div className="mb-4"><Notice tone="bad" title="Run failed">{r.error}</Notice></div>}
      {r.stop_reason === 'budget' && <div className="mb-4"><Notice tone="warn" title="Stopped at the spend cap">Trials after the cap was reached were not run and are marked cancelled.</Notice></div>}
      {r.stop_reason === 'max_answers' && <div className="mb-4"><Notice tone="warn" title="Stopped at the answer limit">The run reached its "Max answers" limit; the questions after it were not asked and are marked cancelled.</Notice></div>}
      {!active && (r.load_errors?.count ?? 0) > 0 && <LoadErrors r={r} />}
      {(r.concurrency ?? 0) >= 8 && !active && <p className="mb-3 text-xs text-ink-3">Asked {r.concurrency} at a time: speed figures include waiting for each other, so compare them only with runs at the same setting.</p>}
      <Tabs
        tabs={[
          { id: 'summary', label: 'Summary' },
          { id: 'cases', label: 'Cases' },
          { id: 'failures', label: <>Failures{s ? <span className="ml-1 rounded bg-bad-wash px-1 text-[11px] text-bad-ink">{s.failed_trials}</span> : null}</> },
          { id: 'metrics', label: 'Metrics' },
          { id: 'traces', label: 'Traces' },
          { id: 'config', label: 'Config' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="mt-4">
        {!s ? <Loading label="Waiting for the first results" /> : (
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {tab === 'summary' && <SummaryTab r={r} s={s} prev={prev} />}
              {tab === 'cases' && <CasesTab runId={r.id} />}
              {tab === 'failures' && <FailuresTab runId={r.id} s={s} />}
              {tab === 'metrics' && <MetricsTab s={s} heuristic={heur} />}
              {tab === 'traces' && <TracesTab runId={r.id} />}
              {tab === 'config' && <ConfigTab r={r} />}
            </motion.div>
          </AnimatePresence>
        )}
      </div>
    </>
  )
}

function Meta({ label, children, hatched }: { label: string; children: React.ReactNode; hatched?: boolean }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-xs', hatched && 'hatched')}>
      <span className="text-ink-3">{label}</span><span className="text-ink">{children}</span>
    </span>
  )
}

function LiveRun({ r }: { r: RunHeader }) {
  const trials = useQuery({ queryKey: ['trials', r.id, 'live'], queryFn: () => api.get<TrialRow[]>(`/api/runs/${r.id}/trials`), refetchInterval: 1500 })
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
  const rows = trials.data ?? []
  const passed = rows.filter((t) => t.status === 'passed').length
  const failed = rows.filter((t) => t.status === 'failed' || t.status === 'error').length
  const spend = rows.reduce((a, t) => a + (t.target_cost_usd ?? 0) + (t.judge_cost_usd ?? 0), 0)
  const elapsed = r.started_at ? Math.round((now - new Date(r.started_at).getTime()) / 1000) : 0
  const p = r.progress_total ? r.progress_done / r.progress_total : 0
  return (
    <div className="mb-5 rounded-xl border border-accent/30 bg-surface p-4 shadow-card">
      <div className="mb-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px]">
        <span className="font-semibold">{r.status === 'queued' ? 'Queued' : 'Running'}</span>
        <span className="num text-ink-2">{r.progress_done} / {r.progress_total} trials</span>
        <span className="num text-good-ink">{passed} passed</span>
        <span className="num text-bad-ink">{failed} failed</span>
        <span className="num text-ink-3">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')} elapsed</span>
        <span className="num text-ink-3">{usd(spend)} spent</span>
        <span className="num ml-auto text-ink-2">{pct(p, 0)}</span>
      </div>
      <ProgressBar value={p} className="mb-3" />
      <LiveGrid total={r.progress_total} done={r.progress_done} statuses={rows.map((t) => ({ key: String(t.id), status: t.status, caseId: t.case_id }))} />
    </div>
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

function GateCard({ r }: { r: RunDetail }) {
  const qc = useQueryClient()
  const gates = useQuery({ queryKey: ['gates'], queryFn: () => api.get<Gate[]>('/api/gates') })
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs?limit=300') })
  const latest = r.gate_results[0]
  const [open, setOpen] = useState(!latest)
  const [gateId, setGateId] = useState<number | ''>(latest?.gate_id ?? '')
  const [baseline, setBaseline] = useState<number | ''>(latest?.baseline_run_id ?? '')
  const apply = useMutation({
    mutationFn: () => api.post<GateResult>(`/api/runs/${r.id}/gate`, { gate_id: gateId || gates.data?.[0]?.id, baseline_run_id: baseline || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['run', String(r.id)] }); setOpen(false) },
  })
  const gateName = gates.data?.find((g) => g.id === latest?.gate_id)?.name
  return (
    <Card title={<Term k="gate">Release gate</Term>} subtitle={latest ? `${gateName ?? 'Gate'}${latest.baseline_run_id ? `, against baseline #${latest.baseline_run_id}` : ', no baseline'}` : undefined}
      actions={latest && <Stamp status={latest.status as 'PASS'} runId={r.id} />}>
      {latest ? (
        <div className="space-y-1.5">
          {latest.results.gates.map((g, i) => (
            <motion.div key={g.gate} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25 + i * 0.05 }}
              className="flex items-center justify-between gap-2 text-[13px]">
              <span className="flex items-center gap-2"><StatusBadge status={g.status} /><code className="text-xs">{g.gate}</code></span>
              <span className="num text-xs text-ink-2">
                {g.value === null ? (g.reason ?? 'n/a') : g.kind === 'relative'
                  ? `${g.value <= 0 ? `up ${pp1(-g.value)}` : `down ${pp1(g.value)}`} vs baseline (max drop ${pp1(g.limit)})`
                  : `${fmtMetric(g.metric, g.value)} ${g.rule === 'min' ? '>=' : '<='} ${fmtMetric(g.metric, g.limit)}`}
              </span>
            </motion.div>
          ))}
          {latest.status === 'INCOMPLETE' && <p className="text-xs text-warn-ink">Some rules could not be evaluated, so this run is not a PASS.</p>}
        </div>
      ) : <p className="text-[13px] text-ink-3">No gate applied yet.</p>}
      <button type="button" onClick={() => setOpen((v) => !v)} className="mt-3 flex items-center gap-1 text-xs font-medium text-accent-ink">
        <ChevronRight className={clsx('size-3.5 transition-transform', open && 'rotate-90')} />{latest ? 'Check against another gate or baseline' : 'Apply a gate'}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-2 grid grid-cols-[1fr_1fr_auto] items-end gap-2 rounded-lg bg-surface-2/60 p-3">
              <Field label="Gate"><Select value={gateId} onChange={(e) => setGateId(e.target.value ? Number(e.target.value) : '')}>{(gates.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</Select></Field>
              <Field label="Baseline run"><Select value={baseline} onChange={(e) => setBaseline(e.target.value ? Number(e.target.value) : '')}><option value="">None</option>{(runs.data ?? []).filter((x) => x.id !== r.id).map((x) => <option key={x.id} value={x.id}>#{x.id} {x.experiment}</option>)}</Select></Field>
              <Button disabled={!gates.data?.length} loading={apply.isPending} onClick={() => apply.mutate()}>Check</Button>
            </div>
            {apply.isError && <div className="mt-2"><ErrorState error={apply.error} /></div>}
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  )
}

function SummaryTab({ r, s, prev }: { r: RunDetail; s: RunSummary; prev: RunHeader | null }) {
  const rel = Object.values(s.reliability).filter((x): x is Reliability => !Array.isArray(x) && typeof x === 'object')
  const flaky = (s.reliability.flaky_cases as string[] | undefined) ?? []
  const tel = s.telemetry
  const stages = useQuery({ queryKey: ['comparability', r.id], queryFn: () => api.get<{ stages: Stage[] }>(`/api/runs/${r.id}/comparability`) })
  const nav = useNavigate()
  const change = prev && prev.metrics.overall_pass_rate != null && s.overall.value != null ? s.overall.value - prev.metrics.overall_pass_rate : null
  const kHi = rel.find((x) => x.k === s.trials_per_case) ?? rel[rel.length - 1]
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label={<Term k="pass_rate">Pass rate</Term>} numeric={s.overall.value} format={(v) => pct(v)}
          sub={<>{s.overall.ci_low !== null ? <><Term k="ci">95% CI</Term> {pct(s.overall.ci_low, 0)}-{pct(s.overall.ci_high, 0)}, </> : ''}n={s.overall.n}
            {change !== null && <span className={clsx('ml-1 font-medium', change > 0 ? 'text-good-ink' : change < 0 ? 'text-bad-ink' : '')}>{change > 0 ? '+' : ''}{(change * 100).toFixed(1)}pp vs #{prev!.id}</span>}</>}
          explain="Questions answered correctly on every gating check." />
        <Stat label="Tool accuracy" numeric={s.metrics.tool_accuracy ?? null} format={(v) => pct(v)} sub="right tool, right arguments" />
        <Stat label={<Term k="p95">p95 latency</Term>} numeric={s.metrics.p95_latency_ms ?? null} format={(v) => ms(v)} sub={<><Term k="p50">p50</Term> {ms(s.metrics.p50_latency_ms)}, n={tel.latency_n}</>} />
        <Stat label="Tokens / question" numeric={s.metrics.average_total_tokens ?? null} format={(v) => num(v)} sub={tel.tokens_n ? `reported on ${tel.tokens_n} trials` : 'not reported by the bot'} />
        <Stat label="Bot cost / question" value={usd(s.metrics.average_cost_usd)} sub={tel.target_cost_n ? 'from the price table' : 'unknown: no usage or price'} />
        <Stat label="Grading cost" value={usd(s.metrics.total_judge_cost_usd)} sub={r.judge ? (r.judge.provider === 'heuristic' ? 'heuristic: free' : `${r.judge.model}`) : 'no judge'} hatched={r.judge?.provider === 'heuristic'} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <GateCard r={r} />
        <Card title="Consistency over repeated tries">
          {s.trials_per_case < 2 ? (
            <p className="text-[13px] text-ink-3">One try per question. Run 3 or more tries to see whether the bot is consistent.</p>
          ) : (
            <>
              {kHi && (
                <p className="mb-3 text-[13px]">
                  Right <b>at least once</b> in {kHi.k} tries: <b className="num">{pct(kHi.pass_at_k)}</b>.
                  Right <b>every time</b>: <b className="num">{pct(kHi.pass_hat_k)}</b>.
                  {kHi.pass_at_k !== null && kHi.pass_hat_k !== null && kHi.pass_at_k - kHi.pass_hat_k > 0.02 && <span className="text-warn-ink"> The gap is flakiness.</span>}
                </p>
              )}
              <Table>
                <thead><tr><th>k</th><th className="text-right"><Term k="pass_at_k">pass@k</Term></th><th className="text-right"><Term k="pass_hat_k">pass^k</Term></th><th className="text-right">Cases</th></tr></thead>
                <tbody>{rel.map((x) => <tr key={x.k}><td className="num">{x.k}</td><td className="num text-right">{pct(x.pass_at_k)}</td><td className="num text-right">{pct(x.pass_hat_k)}</td><td className="num text-right">{x.n_cases}</td></tr>)}</tbody>
              </Table>
              {flaky.length > 0 && <p className="mt-2 text-xs text-warn-ink"><Term k="flaky">Flaky</Term> ({flaky.length}): {flaky.map((c, i) => <span key={c}>{i > 0 && ', '}<Link className="underline" to={`?tab=cases&case=${c}`}>{c}</Link></span>)}</p>}
            </>
          )}
        </Card>
      </div>
      <Card title={<Term k="stage">Where failures start</Term>} subtitle="Click a stage to see its failures">
        {stages.data ? <StagePipeline stages={stages.data.stages} onPick={(st) => nav(`?tab=failures&stage=${st.id}`)} /> : <div className="skeleton h-16" />}
      </Card>
      <Card title="Pass rate by category">
        <PairedBars single data={Object.entries(s.by_category).map(([c, v]) => ({ group: c, baseline: null, candidate: v.pass_rate, n: v.n }))} height={220} />
        <Table className="mt-2">
          <thead><tr><th>Category</th><th className="text-right">Pass rate</th><th className="text-right">Cases</th></tr></thead>
          <tbody>{Object.entries(s.by_category).map(([c, v]) => <tr key={c}><td><Link className="hover:underline" to={`?tab=cases&category=${c}`}>{c}</Link></td><td className="num text-right">{pct(v.pass_rate)}</td><td className="num text-right">{v.n}</td></tr>)}</tbody>
        </Table>
      </Card>
      <p className="text-xs text-ink-3">Started {when(r.started_at)}, took {duration(r.started_at, r.finished_at)}. Rates are averaged per case first (tries of one case are repeats, not new evidence); intervals resample cases.</p>
    </div>
  )
}

function useTrials(runId: number, filters: Record<string, string | undefined>) {
  return useQuery({ queryKey: ['trials', runId, filters], queryFn: () => api.get<TrialRow[]>(`/api/runs/${runId}/trials${qs(filters)}`) })
}

/** Cases, one row each, with a dot per try. Enter opens the first failing try (or the first). */
export function CaseTable({ groups, showChecks = true, keyboard = true, highlight }: { groups: CaseGroup[]; showChecks?: boolean; keyboard?: boolean; highlight?: string | null }) {
  const nav = useNavigate()
  const open = (g: CaseGroup) => nav(`/trials/${(g.firstFailing ?? g.trials[0]).id}`, { viewTransition: true })
  const [active] = useListNav(groups.length, (i) => open(groups[i]), keyboard)
  return (
    <Table>
      <thead><tr><th>Case</th><th>Question</th><th>Tries</th><th>{showChecks ? 'Failed checks / kinds' : ''}</th><th className="text-right">Latency</th></tr></thead>
      <tbody>
        {groups.map((g, i) => (
          <tr key={g.case_id} data-kb-index={i} onClick={() => open(g)}
            className={clsx('cursor-pointer align-top hover:bg-surface-2/60', active === i && 'kb-active', highlight === g.case_id && 'bg-accent-wash')}>
            <td className="whitespace-nowrap">
              <Link className="font-mono text-xs text-accent-ink hover:underline" to={`/trials/${(g.firstFailing ?? g.trials[0]).id}`} onClick={(e) => e.stopPropagation()}>{g.case_id}</Link>
              {g.category && <div className="text-[11px] text-ink-3">{g.category}</div>}
            </td>
            <td className="max-w-md"><div className="line-clamp-2 text-[13px]">{g.question ?? g.title}</div></td>
            <td className="whitespace-nowrap">
              <div className="flex items-center gap-2"><DotStrip statuses={g.statuses} /><Consistency statuses={g.statuses} /></div>
            </td>
            <td>
              {showChecks && (
                <div className="flex flex-wrap gap-1">
                  {g.failure_types.map((f) => <Badge key={f} tone="bad">{FAILURE_LABELS[f] ?? f}</Badge>)}
                  {g.failed_evaluators.slice(0, 4).map((e) => <Badge key={e}>{e}</Badge>)}
                </div>
              )}
            </td>
            <td className="num whitespace-nowrap text-right text-xs">{ms(g.latency_ms)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}

function CasesTab({ runId }: { runId: number }) {
  const [params, setParams] = useSearchParams()
  const state = params.get('state') ?? ''
  const category = params.get('category') ?? ''
  const caseId = params.get('case') ?? ''
  const [search, setSearch] = useState('')
  const q = useTrials(runId, {})
  const groups = useMemo(() => groupByCase(q.data ?? []), [q.data])
  const cats = useMemo(() => [...new Set(groups.map((g) => g.category).filter(Boolean))] as string[], [groups])
  const rows = groups.filter((g) => (!state || g.state === state) && (!category || g.category === category) && (!caseId || g.case_id === caseId)
    && (!search || `${g.case_id} ${g.question} ${g.title}`.toLowerCase().includes(search.toLowerCase())))
  const set = (k: string, v: string) => setParams((p) => { if (v) p.set(k, v); else p.delete(k); return p })
  const count = (st: string) => groups.filter((g) => g.state === st).length
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative"><Search className="absolute left-2 top-2 size-4 text-ink-3" /><Input className="w-64 pl-7" placeholder="Search id or question" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search cases" /></div>
        <Segmented size="sm" label="State" value={state || 'all'} onChange={(v) => set('state', v === 'all' ? '' : v)} options={[
          { id: 'all', label: `All ${groups.length}` }, { id: 'failed', label: `Failing ${count('failed')}` }, { id: 'flaky', label: `Flaky ${count('flaky')}` }, { id: 'passed', label: `Passing ${count('passed')}` },
        ]} />
        <Select className="w-44" value={category} onChange={(e) => set('category', e.target.value)} aria-label="Category filter">
          <option value="">All categories</option>{cats.map((c) => <option key={c}>{c}</option>)}
        </Select>
        {caseId && <Button size="sm" variant="ghost" onClick={() => set('case', '')}>Case {caseId} ×</Button>}
        <span className="ml-auto text-xs text-ink-3">{rows.length} cases, {q.data?.length ?? 0} tries</span>
      </div>
      <Card padded={false}>{q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} /> : rows.length === 0 ? <p className="p-4 text-[13px] text-ink-3">No case matches.</p> : <CaseTable groups={rows} highlight={caseId || null} />}</Card>
    </div>
  )
}

const STAGE_TYPES: Record<string, string[]> = {
  retrieval: ['retrieval_miss'], tools: ['incorrect_tool', 'incorrect_tool_arguments', 'unnecessary_tool', 'tool_result_misused'],
  answer: ['wrong_answer', 'incomplete_response', 'should_have_refused', 'malformed_output'], grounding: ['unsupported_claim', 'citation_error'],
  performance: ['latency_regression', 'cost_regression'], execution: ['execution_error', 'unknown', 'judge_disagreement'],
}

function FailuresTab({ runId, s }: { runId: number; s: RunSummary }) {
  const [params, setParams] = useSearchParams()
  const selected = params.get('failure')
  const stage = params.get('stage')
  const q = useTrials(runId, {})
  const failing = useMemo(() => groupByCase((q.data ?? []).filter((t) => t.status === 'failed' || t.status === 'error')), [q.data])
  const all = useMemo(() => groupByCase(q.data ?? []), [q.data])
  const statusOf = useMemo(() => Object.fromEntries(all.map((g) => [g.case_id, g.statuses])), [all])
  const rows = failing.filter((g) => (!selected || g.failure_types.includes(selected)) && (!stage || g.failure_types.some((f) => STAGE_TYPES[stage]?.includes(f))))
    .map((g) => ({ ...g, statuses: statusOf[g.case_id] ?? g.statuses }))
    .sort((a, b) => a.passed - b.passed)
  const data = Object.entries(s.failures).map(([key, value]) => ({ key, label: FAILURE_LABELS[key] ?? key, value })).sort((a, b) => b.value - a.value)
  if (data.length === 0) return <Empty title="No failures">Every scored try passed its gating checks. The Metrics tab shows checks that did not apply or could not run.</Empty>
  const toggle = (k: string) => setParams((p) => { if (selected === k) p.delete('failure'); else { p.set('failure', k); p.delete('stage') } return p })
  return (
    <div className="grid gap-5 xl:grid-cols-[360px_minmax(0,1fr)]" data-tour="failures">
      <Card title="By kind of failure" subtitle={`${s.failed_trials} failed tries in ${failing.length} cases`}>
        <CountBars data={data} selected={selected} onSelect={toggle} />
        <Explain className="mt-2">A try counts once for each kind of failure it shows, so these add up to more than the failed tries.</Explain>
        {(selected || stage) && <Button size="sm" variant="ghost" className="mt-2" onClick={() => setParams((p) => { p.delete('failure'); p.delete('stage'); return p })}>Clear filter</Button>}
      </Card>
      <Card padded={false} title={selected ? FAILURE_LABELS[selected] ?? selected : stage ? `Stage: ${stage}` : 'Failing cases'}
        subtitle={`${rows.length} case(s) - most consistent failures first - J/K, Enter`}>
        {q.isLoading ? <Loading /> : <CaseTable groups={rows} />}
      </Card>
    </div>
  )
}

const KIND_LABEL: Record<string, string> = { deterministic: 'Objective checks', retrieval: 'Retrieval', agent: 'Agent / tools', performance: 'Latency and cost', llm_judge: 'Meaning (grading model)' }

function MetricsTab({ s, heuristic }: { s: RunSummary; heuristic: boolean }) {
  const evs = useQuery({ queryKey: ['evaluators'], queryFn: () => api.get<{ evaluators: EvaluatorInfo[] }>('/api/evaluators') })
  const info = Object.fromEntries((evs.data?.evaluators ?? []).map((e) => [e.id, e]))
  const kinds = [...new Set(Object.values(s.evaluators).map((m) => m.kind))]
  const fmtMean = (id: string, kind: string, v: number | null) => (v === null ? 'n/a' : id === 'latency' ? ms(v) : id === 'token_budget' ? num(v) : id === 'cost_budget' ? usd(v) : kind === 'retrieval' || kind === 'llm_judge' ? v.toFixed(2) : v.toFixed(2))
  const skipped = (c: Partial<Record<string, number>>) => {
    const parts = [[c.not_applicable, 'not applicable'], [c.not_evaluated, 'not evaluated'], [c.unknown, 'unknown'], [c.error, 'error']].filter(([n]) => n) as [number, string][]
    return parts.length ? parts.map(([n, w]) => `${n} ${w}`).join(', ') : '-'
  }
  return (
    <div className="space-y-5">
      <Explain>Pass rates count only tries where the check reached a verdict. "Not applicable": the question does not ask for it. "Not evaluated": the bot did not report what the check needs.</Explain>
      {kinds.map((kind) => (
        <Card key={kind} title={KIND_LABEL[kind] ?? kind} padded={false}>
          <Table>
            <thead><tr><th>Check</th><th className="text-right">Pass rate</th><th><Term k="ci">95% interval</Term></th><th className="text-right">Mean score</th><th className="text-right">Decided</th><th>Skipped</th></tr></thead>
            <tbody>
              {Object.entries(s.evaluators).filter(([, m]) => m.kind === kind).map(([id, m]) => {
                const heur = heuristic && kind === 'llm_judge'
                return (
                  <tr key={id} className={clsx(heur && 'hatched')}>
                    <td>
                      <span className="font-medium">{info[id]?.name ?? id}</span>
                      {!m.gating && <span className="ml-1 text-xs text-ink-3">(<Term k="gating">diagnostic</Term>)</span>}
                      <span className="ml-1.5 font-mono text-[10px] text-ink-3">v{m.version}</span>
                      {info[id]?.calibration && <div className="text-xs text-ink-3">{heur ? 'heuristic judge' : info[id].calibration!.status}</div>}
                    </td>
                    <td className="num text-right">{pct(m.pass_rate)}</td>
                    <td><IntervalBar value={m.pass_rate} low={m.ci_low} high={m.ci_high} axis /></td>
                    <td className="num text-right">{fmtMean(id, kind, m.mean_score)}</td>
                    <td className="num text-right">{m.n_decided}</td>
                    <td className="text-xs text-ink-3">{skipped(m.counts)}</td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        </Card>
      ))}
    </div>
  )
}

function TracesTab({ runId }: { runId: number }) {
  const q = useTrials(runId, {})
  const rows = (q.data ?? []).filter((t) => t.status !== 'cancelled')
  const [onlyFailing, setOnlyFailing] = useState(false)
  const shown = rows.filter((t) => !onlyFailing || t.status === 'failed' || t.status === 'error')
  const nav = useNavigate()
  const [active, setActive] = useListNav(shown.length, (i) => nav(`/trials/${shown[i].id}`, { viewTransition: true }))
  // Opens on the first failing try; j/k (or a click) moves the pick.
  const pick = (active >= 0 ? shown[active] : shown.find((t) => t.status === 'failed' || t.status === 'error') ?? shown[0])?.id ?? null
  const trial = useQuery({ queryKey: ['trial', pick], queryFn: () => api.get<TrialDetail>(`/api/trials/${pick}`), enabled: pick !== null })
  return (
    <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Card title="Tries" padded={false} actions={<label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" checked={onlyFailing} onChange={(e) => setOnlyFailing(e.target.checked)} className="accent-[var(--accent)]" />failing only</label>}>
        <ul className="scroll-thin max-h-[680px] overflow-y-auto">
          {shown.map((t, i) => (
            <li key={t.id}>
              <button type="button" data-kb-index={i} onClick={() => setActive(i)} className={clsx('flex w-full items-center gap-2 border-b border-line px-3 py-1.5 text-left text-xs hover:bg-surface-2', pick === t.id && 'kb-active')}>
                <span className={clsx('size-2 shrink-0 rounded-full', t.status === 'passed' ? 'bg-good' : t.status === 'error' ? 'bg-error' : 'bg-bad')} />
                <span className="font-mono">{t.case_id}</span><span className="text-ink-3">try {t.trial_index + 1}</span><span className="num ml-auto text-ink-3">{ms(t.latency_ms)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={trial.data ? <>Trace - <span className="font-mono">{trial.data.case_id}</span> try {trial.data.trial_index + 1}</> : 'Trace'} actions={pick && <Button size="sm" onClick={() => nav(`/trials/${pick}`, { viewTransition: true })}>Open trial</Button>}>
        {pick === null ? <p className="text-[13px] text-ink-3">No tries recorded.</p> : trial.isLoading ? <Loading /> : trial.data?.trace ? (
          <div className="space-y-3">
            <div className="text-[13px]"><span className="text-ink-3">Question: </span>{trial.data.question}</div>
            <TraceViewer spans={trial.data.trace.spans} />
            <div className="rounded-lg bg-surface-2/60 p-3 text-[13px]"><span className="text-ink-3">Answer: </span>{trial.data.answer}</div>
          </div>
        ) : <p className="text-[13px] text-ink-3">No trace stored.</p>}
      </Card>
    </div>
  )
}

function ConfigTab({ r }: { r: RunDetail }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const models = useQuery({ queryKey: ['models'], queryFn: () => api.get<ProviderConfig[]>('/api/models') })
  const [judge, setJudge] = useState('')
  const reeval = useMutation({
    mutationFn: () => api.post<RunHeader>(`/api/runs/${r.id}/reevaluate`, judge ? { judge: judge === 'heuristic' ? { provider: 'heuristic' } : { provider_config_id: Number(judge) }, name: `${r.experiment} (re-graded)` } : {}),
    onSuccess: (n) => { qc.invalidateQueries({ queryKey: ['runs'] }); nav(`/runs/${n.id}`, { viewTransition: true }) },
  })
  return (
    <div className="space-y-4">
      <Card title="Re-grade these answers">
        <p className="mb-3 text-[13px] text-ink-2">Grade the stored answers again without asking the bot: after changing a rubric, a threshold, or to see what a different grading model says. The result is a new run linked to this one; this run keeps its grades.</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Grading model">
            <Select className="w-72" value={judge} onChange={(e) => setJudge(e.target.value)} aria-label="Re-grade with">
              <option value="">Same as this run ({r.judge ? r.judge.model : 'none'})</option>
              <option value="heuristic">Heuristic (word overlap)</option>
              {(models.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name} ({whereLabel(m)})</option>)}
            </Select>
          </Field>
          <Button variant="primary" loading={reeval.isPending} onClick={() => reeval.mutate()}><RotateCcw className="size-3.5" /> Re-grade</Button>
        </div>
        {reeval.isError && <div className="mt-2"><ErrorState error={reeval.error} /></div>}
      </Card>
      <Card title="Snapshot (everything this run used)">
        <p className="mb-2 text-xs text-ink-3">Connection configuration and version, dataset version and content hash, check versions, grading model and rubric hashes, and the run settings - frozen at launch.</p>
        <Json value={r.snapshot} maxHeight={640} />
      </Card>
    </div>
  )
}

/** Answers that failed with rate limits or timeouts: probably the load, not the bot. */
function LoadErrors({ r }: { r: RunDetail }) {
  const nav = useNavigate()
  const qc = useQueryClient()
  const e = r.load_errors!
  const lower = Math.max(1, Math.min(2, (r.concurrency ?? 2) - 1))
  const reask = useMutation({
    mutationFn: () => api.post<RunHeader>(`/api/runs/${r.id}/reask-load-errors`, { concurrency: lower }),
    onSuccess: (n) => { qc.invalidateQueries({ queryKey: ['runs'] }); nav(`/runs/${n.id}`, { viewTransition: true }) },
  })
  return (
    <div className="mb-4">
      <Notice tone="warn" title={`${e.count} answer${e.count === 1 ? '' : 's'} failed with "rate limited" or timed out${r.concurrency ? ` at ${r.concurrency} at a time` : ''}`}
        action={<Button size="sm" loading={reask.isPending} onClick={() => reask.mutate()}>Re-ask {e.case_ids.length} at {lower} at a time</Button>}>
        These are probably not the bot's fault: too many questions arrived at once. They count as errors in this run's pass rate. Re-asking them fewer at a time starts a small new run with just those questions.
        {reask.isError && <div className="mt-2"><ErrorState error={reask.error} /></div>}
      </Notice>
    </div>
  )
}
