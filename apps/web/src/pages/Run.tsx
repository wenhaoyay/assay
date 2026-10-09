import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { AlertTriangle, ChevronRight, GitCompareArrows, Lightbulb, RotateCcw, Search, Square } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { CauseBadge, FixFirst, useRunCauses } from '../components/Causes'
import { IntervalBar } from '../components/charts'
import { causeColor, Delta, Fingerprint, FingerprintLegend, Needle, Odometer, SampleSize, type Cell } from '../components/instrument'
import { ReleaseReceipt } from '../components/ReleaseReceipt'
import { ByCategory } from '../components/run/ByCategory'
import { ExploreTab } from '../components/run/Explore'
import { useCaseRates, useComparison, useExplore, useGateFloor, usePreviousComparable, useRunHeader, useRunTrials, variantTitle } from '../components/run/data'
import { finishedTries, LiveFigures, LiveRun } from '../components/run/LiveRun'
import { FlowSankey } from '../components/run/Sankey'
import { ShareMenu } from '../components/Share'
import { TraceViewer } from '../components/TraceViewer'
import { Confetti, Stamp, StagePipeline } from '../components/viz'
import {
  Badge, Button, Card, Consistency, DotStrip, Empty, ErrorState, Field, Figs, GaugeArt, Help, InlineError, Input, Json, Loading, Notice,
  PageSkeleton, Segmented, Select, Stat, StatusBadge, Table, Tabs, Term, linkButton, useLongWork,
} from '../components/ui'
import { api, qs } from '../lib/api'
import { whereLabel } from '../lib/models'
import { useCrumbs } from '../lib/crumbs'
import { duration, FAILURE_LABELS, ms, num, pct, score, usd, when } from '../lib/format'
import { isCompleted, isLive, questionsOf } from '../lib/runstate'
import { useHotkey, useListNav } from '../lib/hotkeys'
import { groupByCase, type CaseGroup } from '../lib/trials'
import type { EvaluatorInfo, Gate, GateResult, Metrics, ProviderConfig, Reliability, RunDetail, RunHeader, RunSummary, Stage, TrialDetail, TrialRow, Verdict } from '../lib/types'

type RTab = 'summary' | 'cases' | 'failures' | 'explore' | 'metrics' | 'traces' | 'config'
const TABS: RTab[] = ['summary', 'cases', 'failures', 'explore', 'metrics', 'traces', 'config']
const CONFETTI_KEY = 'gl-confetti-fired'

const shortDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '')

export function RunPage() {
  const { id } = useParams()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as RTab) ?? 'summary'
  const setTab = (t: RTab) => setParams((p) => { p.set('tab', t); return p })
  const qc = useQueryClient()
  const [sawActive, setSawActive] = useState(false)
  const run = useQuery({
    queryKey: ['run', id],
    queryFn: () => api.get<RunDetail>(`/api/runs/${id}`),
    refetchInterval: (q) => {
      const d = q.state.data
      if (d && isLive(d.status)) return 1500
      return sawActive && d && !d.gate_results.length && Date.now() - new Date(d.finished_at ?? 0).getTime() < 20000 ? 2000 : false
    },
  })
  const r0 = run.data
  const active = !!r0 && isLive(r0.status)
  useEffect(() => { if (active) setSawActive(true) }, [active])
  // Poll the tries only while the run is live; one last read when it ends.
  const trials = useRunTrials(r0?.id, active)
  const finalStatus = !active ? r0?.status : undefined
  const r0id = r0?.id
  useEffect(() => { if (sawActive && finalStatus && r0id) qc.invalidateQueries({ queryKey: ['trials', r0id] }) }, [sawActive, finalStatus, r0id, qc])
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get<{ id: number; name: string }[]>('/api/projects') })
  const cancel = useMutation({ mutationFn: () => api.post(`/api/runs/${id}/cancel`), onSuccess: () => qc.invalidateQueries({ queryKey: ['run', id] }), meta: { silent: true } })
  const again = useMutation({
    mutationFn: () => api.post<{ id?: number; run_id?: number }>(`/api/experiments/${r0?.experiment_id}/run`),
    onSuccess: (res) => { qc.invalidateQueries({ queryKey: ['runs'] }); const n = res?.run_id ?? res?.id; if (n) nav(`/runs/${n}`) },
    meta: { silent: true },
  })
  const prev = usePreviousComparable(r0)
  const baseId = r0?.gate_results?.[0]?.baseline_run_id ?? prev?.id ?? null
  const base = useRunHeader(baseId)
  const cmp = useComparison(!active && baseId ? baseId : null, r0?.id)
  const floor = useGateFloor(r0?.project_id)
  const project = projects.data?.find((p) => p.id === r0?.project_id)
  useCrumbs([
    ...(project ? [{ label: project.name, to: `/p/${project.id}` }] : [{ label: 'Runs', to: '/runs' }]),
    { label: `Run #${id}` },
  ], `run-${id}-${project?.name}`)

  useHotkey(['1', '2', '3', '4', '5', '6', '7'], (ev) => setTab(TABS[Number(ev.key) - 1]))
  useHotkey('c', () => nav(prev ? `/compare?baseline=${prev.id}&candidate=${id}` : `/compare?candidate=${id}`, { viewTransition: true }), !!run.data && isCompleted(run.data.status))

  // The finish: the gate stamps in, the receipt prints and, the first time a gate passes in this
  // browser session, confetti.
  const justFinished = sawActive && !active && !!r0 && isCompleted(r0.status)
  const gateNow = r0?.gate_results?.[0]
  const [fire, setFire] = useState(false)
  useEffect(() => {
    if (!justFinished || gateNow?.status !== 'PASS') return
    try {
      if (sessionStorage.getItem(CONFETTI_KEY)) return
      sessionStorage.setItem(CONFETTI_KEY, '1')
    } catch { /* storage off: fire anyway */ }
    setFire(true)
  }, [justFinished, gateNow?.status])

  const groups = useMemo(() => groupByCase(trials.data ?? []), [trials.data])
  const cells: Cell[] = useMemo(() => groups.map((g) => ({ id: g.case_id, passed: g.passed, total: g.decided, title: g.title })), [groups])
  const firstTry = useMemo(() => Object.fromEntries(groups.map((g) => [g.case_id, g.trials[0]?.id])), [groups])

  if (run.isLoading) return <PageSkeleton />
  if (run.isError) return <ErrorState error={run.error} />
  const r = run.data!
  const s = r.summary
  const heur = r.judge?.provider === 'heuristic'
  const fin = finishedTries(trials.data ?? [])
  const passSoFar = fin.length ? fin.filter((t) => t.status === 'passed').length / fin.length : null
  const nFailing = trials.data ? groups.filter((g) => g.decided && g.passed < g.decided).length : s?.failed_trials ?? null
  const [v1, v2] = variantTitle(r)
  const overallCmp = cmp.data?.metrics.find((m) => m.metric === 'overall_pass_rate')
  const delta = overallCmp?.delta ?? (base && s?.overall.value != null && base.metrics.overall_pass_rate != null ? s.overall.value - base.metrics.overall_pass_rate : null)

  let needle: ReactNode
  let needleNote: ReactNode
  if (active) {
    needle = <Needle mode="level" value={passSoFar ?? 0} gate={floor} tremble size={190} label="Pass rate so far" />
    needleNote = <>pass rate so far{fin.length ? <>, <span className="num font-mono">{fin.length}</span> answers</> : null}</>
  } else if (base && delta !== null && !r.off_topic) {
    const ci = overallCmp?.ci
    needle = <Needle mode="delta" value={delta} low={ci?.ci_low} high={ci?.ci_high} size={190} label={`Pass rate change vs run ${base.id}`} />
    needleNote = <>vs <Link className="font-mono hover:underline" to={`/runs/${base.id}`}>#{base.id}</Link>: <span className={clsx('num font-mono font-semibold', delta > 0.005 ? 'text-good-ink' : delta < -0.005 ? 'text-bad-ink' : 'text-ink')}>{delta > 0 ? '+' : ''}{(delta * 100).toFixed(1)}pp</span>
      {ci && ci.ci_low !== null && ci.ci_high !== null && <>, interval <span className="num font-mono">{signedPp(ci.ci_low)}</span> to <span className="num font-mono">{signedPp(ci.ci_high)}</span></>}</>
  } else {
    needle = <Needle mode="level" value={s?.overall.value ?? null} gate={floor} size={190} label="Pass rate" />
    needleNote = r.off_topic ? 'left out of trends' : prev ? null : 'first reading'
  }

  return (
    <>
      <Confetti fire={fire} />
      <div className="mb-7 flex flex-wrap items-start gap-x-8 gap-y-5">
        <div className="min-w-0 flex-1">
          <div className="t-label flex flex-wrap items-center gap-x-1.5">
            <span>Run <span className="font-mono">#{r.id}</span></span>
            {project && <><span>·</span><Link className="hover:text-ink" to={`/p/${project.id}`}>{project.name}</Link></>}
            <span>·</span><span>{shortDate(r.created_at)}</span>
            {r.status !== 'completed' && <span className="ml-1.5"><StatusBadge status={r.status} /></span>}
          </div>
          <h1 className="t-title mt-1.5" style={{ viewTransitionName: `run-title-${r.id}` }}>{v1}{v2 && <>, <em>{v2}</em></>}</h1>
          <p className="mt-2.5 max-w-3xl text-base text-ink-2">
            Asked <span className="font-semibold text-ink"><span className="num">{questionsOf(r) ?? 'n/a'}</span> questions × <span className="num">{r.trials_per_case}</span> {r.trials_per_case === 1 ? 'try' : 'tries'}</span>{r.case_filter && ' (a reduced set)'} from{' '}
            {r.dataset_id ? <Link className="font-mono text-sm hover:underline" to={`/datasets/${r.dataset_id}`}>{r.dataset} v{r.dataset_version}</Link> : <span className="font-mono text-sm">{r.dataset} v{r.dataset_version}</span>}
            , graded by checks{r.judge ? <> and {heur
              ? <>the <span className="hatched rounded px-1">heuristic judge</span> (word overlap) <Help title="Heuristic judge"><p>Meaning checks (correctness, groundedness) were scored by word overlap with the reference, not by a grading model. Free and offline, but it cannot recognise paraphrase or negation, so those scores are hatched wherever they appear.</p><p>Re-grade the stored answers with a model in the Config tab.</p></Help></>
              : <span className="font-mono text-sm">{r.judge.provider}/{r.judge.model}</span>}</> : ' only'}.
            {' '}Connection <Link className="font-medium text-ink hover:underline" to={r.target_id ? `/targets/${r.target_id}` : '/targets'}>{r.target}</Link> <span className="font-mono text-sm">v{r.target_version}</span>.
            {r.source !== 'live' && <> {r.source === 'reevaluated' ? <>Re-graded from <Link className="font-mono underline" to={`/runs/${r.parent_run_id}`}>#{r.parent_run_id}</Link>.</> : <>Source: {r.source}.</>}</>}
            {(r.concurrency ?? 0) >= 8 && <> Asked {r.concurrency} at a time <Help title="Speed under load"><p>Asked {r.concurrency} at a time: speed figures include waiting for each other, so compare them only with runs at the same setting.</p></Help></>}
            {' '}<span className="whitespace-nowrap font-mono text-xs text-ink-3">{r.experiment}</span>
          </p>
          {r.off_topic && (
            <p className="mt-2.5 flex items-center gap-2 text-sm font-medium text-warn-ink" data-testid="off-topic">
              <AlertTriangle className="size-4 shrink-0" />This run asked {r.off_topic}'s questions: its results say nothing about this bot, and it is left out of trends.
            </p>
          )}
          {cells.length > 0 && (
            <div className="mt-5">
              <Fingerprint cells={cells} size="lg" vt={`fp-run-${r.id}`} hrefFor={(c) => (firstTry[c] ? `/trials/${firstTry[c]}` : null)} />
              <div className="mt-2 flex items-center gap-3">
                <FingerprintLegend />
                <Help title="The run's fingerprint"><p>One dot per question, in dataset order. Green passed every try, amber some, red none.</p><p>Hover a dot to light that question everywhere on the page; click it to open its answer.</p></Help>
              </div>
            </div>
          )}
        </div>
        <div className="flex flex-col items-center gap-1.5" data-testid="run-needle">
          {needle}
          {needleNote && <div className="text-xs text-ink-2">{needleNote}</div>}
          {gateNow && !active && <div className="mt-1.5"><Stamp status={gateNow.status as 'PASS'} runId={r.id} /></div>}
        </div>
      </div>

      {r.error && <div className="mb-4"><Notice tone="bad" title="Run failed">{r.error}</Notice></div>}
      {r.status === 'cancelled' && r.stop_reason !== 'budget' && r.stop_reason !== 'max_answers' && <div className="mb-4"><Notice tone="warn" title="Stopped">Stopped. Answers finished before the stop are kept; the rest are marked cancelled.</Notice></div>}
      {r.stop_reason === 'budget' && <div className="mb-4"><Notice tone="warn" title="Stopped at the spend cap">Trials after the cap was reached were not run and are marked cancelled.</Notice></div>}
      {r.stop_reason === 'max_answers' && <div className="mb-4"><Notice tone="warn" title="Stopped at the answer limit">The run reached its "Max answers" limit; the questions after it were not asked and are marked cancelled.</Notice></div>}
      {!active && (r.load_errors?.count ?? 0) > 0 && <LoadErrors r={r} />}

      {(active || justFinished) && (
        <section className="mb-10">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
            <LiveFigures r={r} rows={trials.data ?? []} now={Date.now()} />
            {active && (
              <div className="flex flex-col items-end gap-1">
                <Button variant="danger" loading={cancel.isPending} disabled={r.status === 'cancelling'} onClick={() => cancel.mutate()}><Square className="size-3.5" /> {r.status === 'cancelling' ? 'Stopping…' : 'Stop run'}</Button>
                {r.status === 'cancelling' && <p className="max-w-xs text-right text-xs text-ink-2">Stopping the answers still in flight. Answers finished so far are kept.</p>}
                <InlineError error={cancel.error} />
              </div>
            )}
          </div>
          <LiveRun r={r} rows={trials.data ?? []} gate={floor} />
          {justFinished && <FinishedGate r={r} />}
        </section>
      )}

      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <Tabs
            tabs={[
              { id: 'summary', label: 'Summary' },
              { id: 'cases', label: 'Cases' },
              { id: 'failures', label: <>Failures{nFailing ? <span className="ml-1.5 rounded-full bg-bad-wash px-1.5 font-mono text-label text-bad-ink">{nFailing}</span> : null}</> },
              { id: 'explore', label: <>Explore<span className="ml-1.5 rounded-full bg-accent-wash px-1.5 text-label text-accent-ink">new</span></> },
              { id: 'metrics', label: 'Metrics' },
              { id: 'traces', label: 'Traces' },
              { id: 'config', label: 'Config' },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
        {!active && (
          <div className="flex shrink-0 items-center gap-2 pb-1.5">
            {isCompleted(r.status) && <Link className={linkButton('secondary', 'sm')} to={prev ? `/compare?baseline=${prev.id}&candidate=${r.id}` : `/compare?candidate=${r.id}`} viewTransition title="Compare (C)">
              <GitCompareArrows className="size-3.5" /> {prev ? `Compare with #${prev.id}` : 'Compare'}</Link>}
            <ShareMenu runId={r.id} baselineId={prev?.id} />
          </div>
        )}
      </div>
      <div className="mt-6">
        {!s ? (active ? <p className="text-sm text-ink-3">The tabs fill in when the run finishes.</p>
          : r.status === 'failed' || r.status === 'cancelled' ? (
            <Empty title={r.status === 'failed' ? 'This run failed before any results were written' : 'This run was stopped before any results were written'}
              action={r.experiment_id ? <div className="flex flex-col items-start gap-1"><Button variant="primary" loading={again.isPending} onClick={() => again.mutate()}><RotateCcw className="size-3.5" /> Run again</Button><InlineError error={again.error} /></div> : undefined}>
              {r.error ?? 'No answers were kept.'}
            </Empty>
          ) : <Loading label="Waiting for the first results" />) : (
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {tab === 'summary' && <SummaryTab r={r} s={s} base={base} cmpCats={cmp.data?.by_category ?? null} />}
              {tab === 'cases' && <CasesTab runId={r.id} />}
              {tab === 'failures' && <FailuresTab runId={r.id} s={s} baseId={base?.id ?? null} />}
              {tab === 'explore' && <ExploreTab runId={r.id} />}
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

const signedPp = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v * 100))}pp`

/** When a live run finishes: the gate's verdict, its stamp and the release receipt. */
function FinishedGate({ r }: { r: RunDetail }) {
  const g = r.gate_results[0]
  if (!g) return <p className="mt-6 text-sm text-ink-3">All answers are in. No release gate was checked on this run; apply one under Summary.</p>
  const broke = g.results.gates.filter((c) => c.status !== 'PASS')
  return (
    <div className="mt-10" data-testid="finished-gate">
      <Card title="Release gate" help={<p>Checked against every rule of the release gate the moment the last answer arrived.</p>}>
        <div className="flex flex-wrap items-start gap-10">
          <div className="flex max-w-lg flex-col gap-4">
            <p className="t-verdict">
              {g.status === 'PASS' ? <>Every rule holds. <em>Ship it</em>, or keep the receipt for whoever asks.</>
                : g.status === 'FAIL' ? <>A rule broke: <em>{broke.map((c) => c.gate).join(', ')}</em>.</>
                  : <>Some rules could not be checked, so this is <em>not a pass</em>.</>}
            </p>
            <div><Stamp status={g.status as 'PASS'} runId={r.id} /></div>
          </div>
          <ReleaseReceipt run={r} className="max-w-sm flex-1" />
        </div>
      </Card>
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
    <Card title="Release gate" meta={latest?.baseline_run_id ? `vs #${latest.baseline_run_id}` : undefined}
      help={<>{latest && <p>Checked against <b>{gateName ?? 'a gate'}</b>{latest.baseline_run_id ? `, with run #${latest.baseline_run_id} as the baseline` : ', with no baseline'}.</p>}<p>A gate is a set of rules a run must meet to ship: floors on figures (pass rate at least 70%) and limits on how far a figure may fall against a baseline run.</p><p>Each rule shows the run's figure against its limit. Check the run against another gate or baseline below.</p></>}
      actions={latest && <Stamp status={latest.status as 'PASS'} runId={r.id} />}>
      {latest ? (
        <div className="space-y-1.5">
          {latest.results.gates.map((g, i) => (
            <motion.div key={g.gate} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.25 + i * 0.05 }}
              className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2"><StatusBadge status={g.status} /><code className="font-mono text-xs">{g.gate}</code></span>
              <span className="num text-xs text-ink-2">
                {g.value === null ? (g.reason ?? 'n/a') : g.kind === 'relative'
                  ? `${g.value <= 0 ? `up ${pp1(-g.value)}` : `down ${pp1(g.value)}`} vs baseline (max drop ${pp1(g.limit)})`
                  : `${fmtMetric(g.metric, g.value)} ${g.rule === 'min' ? '>=' : '<='} ${fmtMetric(g.metric, g.limit)}`}
              </span>
            </motion.div>
          ))}
          {latest.status === 'INCOMPLETE' && <p className="text-xs text-warn-ink">Some rules could not be evaluated, so this run is not a PASS.</p>}
        </div>
      ) : <p className="text-sm text-ink-3">No gate applied yet.</p>}
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

interface Fig { key: string; label: string; value: number | null | undefined; text: (v: number) => string; delta: (v: number, b: number) => number; fmtDelta: (abs: number, d: number, b: number) => string; higher: boolean; noise: number; missing: string; help: ReactNode }

function figures(m: Metrics): Fig[] {
  const rate = (abs: number) => `${(abs * 100).toFixed(1)}pp`
  return [
    { key: 'overall_pass_rate', label: 'Pass rate', value: m.overall_pass_rate, text: (v) => pct(v), delta: (v, b) => v - b, fmtDelta: rate, higher: true, noise: 0.0005, missing: 'pass rate', help: null },
    { key: 'tool_accuracy', label: 'Tool accuracy', value: m.tool_accuracy, text: (v) => pct(v), delta: (v, b) => v - b, fmtDelta: rate, higher: true, noise: 0.0005, missing: 'tool accuracy (no question names the tool it needs)', help: <p>Right tool, right arguments, over the questions that need a tool.</p> },
    { key: 'recall_at_k.mean', label: 'Search recall', value: m['recall_at_k.mean'], text: (v) => pct(v), delta: (v, b) => v - b, fmtDelta: rate, higher: true, noise: 0.0005, missing: 'search recall (the bot does not send the passages it read)', help: <p>Share of the documents a question needs that were among the passages the bot read (recall@k, averaged).</p> },
    { key: 'must_mention', label: 'Must-mention', value: m.must_mention, text: (v) => pct(v), delta: (v, b) => v - b, fmtDelta: rate, higher: true, noise: 0.0005, missing: 'must-mention (no question lists phrases an answer must contain)', help: <p>Answers that contain every phrase the question says a correct answer must mention.</p> },
    { key: 'p95_latency_ms', label: 'p95 speed', value: m.p95_latency_ms, text: (v) => ms(v), delta: (v, b) => v - b, fmtDelta: (a) => ms(a), higher: false, noise: 30, missing: 'speed', help: <p>95 in 100 answers arrived faster than this. Median: {ms(m.p50_latency_ms)}.</p> },
    { key: 'average_total_tokens', label: 'Tokens / answer', value: m.average_total_tokens, text: (v) => num(v), delta: (v, b) => v - b, fmtDelta: (a, _d, b) => `${b ? Math.round((a / b) * 100) : 0}%`, higher: false, noise: 5, missing: 'tokens (the bot does not report its usage)', help: <p>Tokens the bot reported per answer, prompt and reply together.</p> },
    { key: 'average_cost_usd', label: 'Cost / answer', value: m.average_cost_usd, text: (v) => usd(v), delta: (v, b) => v - b, fmtDelta: (a) => usd(a), higher: false, noise: 1e-6, missing: 'cost (no reported usage, or no price for the model)', help: <p>From the reported tokens and the price table in Settings.</p> },
  ]
}

function SummaryTab({ r, s, base, cmpCats }: { r: RunDetail; s: RunSummary; base: RunHeader | null; cmpCats: { category: string; baseline: number | null }[] | null }) {
  const rel = Object.values(s.reliability).filter((x): x is Reliability => !Array.isArray(x) && typeof x === 'object')
  const flaky = (s.reliability.flaky_cases as string[] | undefined) ?? []
  const stages = useQuery({ queryKey: ['comparability', r.id], queryFn: () => api.get<{ stages: Stage[] }>(`/api/runs/${r.id}/comparability`) })
  const explore = useExplore(r.id)
  const nav = useNavigate()
  const kHi = rel.find((x) => x.k === s.trials_per_case) ?? rel[rel.length - 1]
  const heur = r.judge?.provider === 'heuristic'
  const metrics: Metrics = { ...s.metrics, overall_pass_rate: s.overall.value ?? s.metrics.overall_pass_rate }
  const figs = figures(metrics)
  const shown = figs.filter((f) => f.value !== null && f.value !== undefined)
  const missing = figs.filter((f) => f.value === null || f.value === undefined)
  const baseCats = cmpCats ? Object.fromEntries(cmpCats.map((c) => [c.category, { pass_rate: c.baseline, n: 0 }])) : null
  return (
    <div className="space-y-12">
      <div>
        <Figs>
          {shown.map((f) => {
            const b = base?.metrics[f.key]
            const d = b !== null && b !== undefined ? f.delta(f.value as number, b) : null
            const help = f.key === 'overall_pass_rate'
              ? <><p>Questions answered correctly on every gating check, averaged per question first (tries of one question are repeats, not new evidence).</p>{s.overall.ci_low !== null && <p>95% interval {pct(s.overall.ci_low, 0)} to {pct(s.overall.ci_high, 0)}, resampling questions; n={s.overall.n}.</p>}</>
              : f.help
            return (
              <Stat key={f.key} label={f.label} help={help}
                value={<Odometer text={f.text(f.value as number)} />}
                delta={base ? <Delta value={d} higherIsBetter={f.higher} noise={f.noise} format={(a, dd) => f.fmtDelta(a, dd, b ?? 0)} suffix={<>vs <span className="font-mono">#{base.id}</span></>} />
                  : undefined} />
            )
          })}
        </Figs>
        {(missing.length > 0 || heur) && (
          <p className="mt-3 flex flex-wrap items-center gap-x-1.5 text-sm text-ink-3" data-testid="not-measured">
            <Lightbulb className="size-3.5 shrink-0" />
            Not measured: {[...missing.map((f) => f.missing), ...(heur ? ['correctness and groundedness by a grading model (this run used the word-overlap heuristic)'] : [])].join('; ')}.
            {missing.length > 0 && r.target_id && <Link className="font-medium text-accent-ink underline underline-offset-2" to={`/targets/${r.target_id}#reading`}>How to turn it on</Link>}
            {heur && <Link className="font-medium text-accent-ink underline underline-offset-2" to="?tab=config">Re-grade with a model</Link>}
          </p>
        )}
      </div>

      {explore.data && <FlowSankey trials={explore.data.trials} />}

      <div className="grid gap-12 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        {s.failed_trials > 0 ? <FixFirst runId={r.id} targetId={r.target_id} onPick={(c) => nav(`?tab=failures&cause=${c ?? ''}`)} /> : <Card title="What to fix first"><p className="text-sm text-ink-2">Nothing failed. Every scored try passed its gating checks.</p></Card>}
        <ByCategory cats={s.by_category} base={baseCats} baseId={base?.id ?? null} />
      </div>

      <div className="grid gap-12 lg:grid-cols-2">
        <GateCard r={r} />
        <Card title="Consistency over repeated tries" meta={kHi ? <SampleSize n={kHi.n_cases} unit="questions" /> : undefined}
          help={<><p>pass@k: right at least once in k tries. pass^k: right every time. The gap between them is flakiness: questions the bot sometimes gets right.</p><p>Run 3 or more tries per question to see it.</p></>}>
          {s.trials_per_case < 2 ? (
            <p className="text-sm text-ink-3">One try per question. Run 3 or more tries to see whether the bot is consistent.</p>
          ) : (
            <>
              {kHi && (
                <p className="t-readout mb-3">
                  Right at least once in {kHi.k} tries: <span className="num font-mono">{pct(kHi.pass_at_k)}</span>.
                  Right every time: <span className="num font-mono">{pct(kHi.pass_hat_k)}</span>.
                  {kHi.pass_at_k !== null && kHi.pass_hat_k !== null && kHi.pass_at_k - kHi.pass_hat_k > 0.02 && <span className="text-warn-ink"> The gap is flakiness.</span>}
                </p>
              )}
              <Table>
                <thead><tr><th>k</th><th className="text-right"><Term k="pass_at_k">pass@k</Term></th><th className="text-right"><Term k="pass_hat_k">pass^k</Term></th><th className="text-right">Questions</th></tr></thead>
                <tbody>{rel.map((x) => <tr key={x.k}><td className="num font-mono">{x.k}</td><td className="num text-right font-mono">{pct(x.pass_at_k)}</td><td className="num text-right font-mono">{pct(x.pass_hat_k)}</td><td className="num text-right font-mono">{x.n_cases}</td></tr>)}</tbody>
              </Table>
              {flaky.length > 0 && <p className="mt-2 text-xs text-warn-ink"><Term k="flaky">Flaky</Term> ({flaky.length}): {flaky.map((c, i) => <span key={c}>{i > 0 && ', '}<Link className="font-mono underline" to={`?tab=cases&case=${c}`} data-case={c}>{c}</Link></span>)}</p>}
            </>
          )}
        </Card>
      </div>
      <Card title="Where failures start" help={<p>Failures counted by the pipeline stage where they begin: retrieval, tools, the answer, grounding, speed and cost. Click a stage to see its failures.</p>}>
        {stages.data ? <StagePipeline stages={stages.data.stages} onPick={(st) => nav(`?tab=failures&stage=${st.id}`)} /> : <div className="skeleton h-16" />}
      </Card>
      <p className="text-xs text-ink-3">Started {when(r.started_at)}, took {duration(r.started_at, r.finished_at)}. Grading cost {usd(s.metrics.total_judge_cost_usd)}{heur ? ' (heuristic: free)' : ''}.
        <span className="ml-1 inline-block align-middle"><Help title="How rates are counted"><p>Rates are averaged per question first (tries of one question are repeats, not new evidence); intervals resample questions.</p></Help></span></p>
    </div>
  )
}

/** Cases, one row each, with a dot per try. Enter opens the first failing try (or the first). */
export function CaseTable({ groups, showChecks = true, keyboard = true, highlight, causes }: {
  groups: CaseGroup[]; showChecks?: boolean; keyboard?: boolean; highlight?: string | null; causes?: Record<string, Verdict>
}) {
  const nav = useNavigate()
  const open = (g: CaseGroup) => nav(`/trials/${(g.firstFailing ?? g.trials[0]).id}`, { viewTransition: true })
  const [active] = useListNav(groups.length, (i) => open(groups[i]), keyboard)
  return (
    <Table>
      <thead><tr><th>Question</th><th>Tries</th><th>{showChecks ? 'Likely cause' : ''}</th><th className="text-right">Speed</th></tr></thead>
      <tbody>
        {groups.map((g, i) => {
          const v = causes && g.firstFailing ? causes[g.firstFailing.id] : undefined
          return (
            <tr key={g.case_id} data-kb-index={i} data-case={g.case_id} onClick={() => open(g)}
              className={clsx('cursor-pointer align-top hover:bg-surface-2/60', active === i && 'kb-active', highlight === g.case_id && 'bg-accent-wash')}>
              <td className="max-w-xl">
                <div className="flex items-baseline gap-2">
                  <Link className="font-mono text-xs text-accent-ink hover:underline" to={`/trials/${(g.firstFailing ?? g.trials[0]).id}`} onClick={(e) => e.stopPropagation()}>{g.case_id}</Link>
                  <span className="font-medium">{g.title}</span>
                  {g.category && <span className="text-xs text-ink-3">{g.category.replace(/_/g, ' ')}</span>}
                </div>
                {g.question && g.question !== g.title && <div className="mt-0.5 line-clamp-2 text-sm text-ink-2">{g.question}</div>}
              </td>
              <td className="whitespace-nowrap">
                <div className="flex items-center gap-2"><DotStrip statuses={g.statuses} /><Consistency statuses={g.statuses} /></div>
              </td>
              <td>
                {showChecks && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {v ? <CauseBadge v={v} /> : g.failure_types.slice(0, 1).map((f) => <Badge key={f} tone="bad">{FAILURE_LABELS[f] ?? f}</Badge>)}
                    {g.failed_evaluators[0] && <span className="font-mono text-xs text-ink-3">{g.failed_evaluators[0]}{g.failed_evaluators.length > 1 ? ` +${g.failed_evaluators.length - 1}` : ''}</span>}
                  </div>
                )}
              </td>
              <td className="num whitespace-nowrap text-right font-mono text-xs">{ms(g.latency_ms)}</td>
            </tr>
          )
        })}
      </tbody>
    </Table>
  )
}

function useTrials(runId: number, filters: Record<string, string | undefined>) {
  return useQuery({ queryKey: ['trials', runId, filters], queryFn: () => api.get<TrialRow[]>(`/api/runs/${runId}/trials${qs(filters)}`) })
}

function CasesTab({ runId }: { runId: number }) {
  const [params, setParams] = useSearchParams()
  const state = params.get('state') ?? ''
  const category = params.get('category') ?? ''
  const caseId = params.get('case') ?? ''
  const [search, setSearch] = useState('')
  const q = useTrials(runId, {})
  const causes = useRunCauses(runId)
  const groups = useMemo(() => groupByCase(q.data ?? []), [q.data])
  const cats = useMemo(() => [...new Set(groups.map((g) => g.category).filter(Boolean))] as string[], [groups])
  const rows = groups.filter((g) => (!state || g.state === state) && (!category || g.category === category) && (!caseId || g.case_id === caseId)
    && (!search || `${g.case_id} ${g.question} ${g.title}`.toLowerCase().includes(search.toLowerCase())))
  const set = (k: string, v: string) => setParams((p) => { if (v) p.set(k, v); else p.delete(k); return p })
  const count = (st: string) => groups.filter((g) => g.state === st).length
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative"><Search className="absolute left-2 top-2 size-4 text-ink-3" /><Input className="w-64 pl-7" placeholder="Search id or question" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search cases" /></div>
        <Segmented size="sm" label="State" value={state || 'all'} onChange={(v) => set('state', v === 'all' ? '' : v)} options={[
          { id: 'all', label: `All ${groups.length}` }, { id: 'failed', label: `Failing ${count('failed')}` }, { id: 'flaky', label: `Flaky ${count('flaky')}` }, { id: 'passed', label: `Passing ${count('passed')}` },
        ]} />
        <Select className="w-44" value={category} onChange={(e) => set('category', e.target.value)} aria-label="Category filter">
          <option value="">All categories</option>{cats.map((c) => <option key={c}>{c}</option>)}
        </Select>
        {caseId && <Button size="sm" variant="ghost" onClick={() => set('case', '')}>Case {caseId} ×</Button>}
        <Help title="Every question"><p>One row per question with a dot per try. Flaky questions pass some tries and fail others. J and K move between rows, Enter opens the answer.</p></Help>
        <span className="ml-auto font-mono text-xs text-ink-3">{rows.length} questions · {q.data?.length ?? 0} tries</span>
      </div>
      {q.isLoading ? <Loading /> : q.isError ? <ErrorState error={q.error} /> : rows.length === 0 ? <p className="py-4 text-sm text-ink-3">No question matches.</p> : <CaseTable groups={rows} highlight={caseId || null} causes={causes.data?.by_trial} />}
    </div>
  )
}

const STAGE_TYPES: Record<string, string[]> = {
  retrieval: ['retrieval_miss'], tools: ['incorrect_tool', 'incorrect_tool_arguments', 'unnecessary_tool', 'tool_result_misused'],
  answer: ['wrong_answer', 'incomplete_response', 'should_have_refused', 'malformed_output'], grounding: ['unsupported_claim', 'citation_error'],
  performance: ['latency_regression', 'cost_regression'], execution: ['execution_error', 'unknown', 'judge_disagreement'],
}

function FailuresTab({ runId, s, baseId }: { runId: number; s: RunSummary; baseId: number | null }) {
  const [params, setParams] = useSearchParams()
  const nav = useNavigate()
  const selected = params.get('failure')
  const stage = params.get('stage')
  const cause = params.get('cause') || null
  const [mode, setMode] = useState<'all' | 'changed'>('all')
  const [search, setSearch] = useState('')
  const causes = useRunCauses(runId)
  const q = useTrials(runId, {})
  const baseRates = useCaseRates(baseId)
  const all = useMemo(() => groupByCase(q.data ?? []), [q.data])
  const failingAll = useMemo(() => all.filter((g) => g.decided && g.passed < g.decided).map((g) => {
    const v = g.firstFailing ? causes.data?.by_trial?.[g.firstFailing.id] : undefined
    const rate = g.passed / g.decided
    return { g, v, rate, b: baseRates ? baseRates[g.case_id] ?? null : null }
  }).sort((a, b) => a.rate - b.rate || (a.v?.cause ?? '').localeCompare(b.v?.cause ?? '')), [all, causes.data, baseRates])
  const changed = (x: (typeof failingAll)[number]) => x.b === null || Math.abs(x.b - x.rate) > 1e-9
  const rows = failingAll.filter(({ g, v }) => (!selected || g.failure_types.includes(selected)) && (!stage || g.failure_types.some((f) => STAGE_TYPES[stage]?.includes(f)))
    && (!cause || v?.cause === cause))
    .filter((x) => mode === 'all' || changed(x))
    .filter(({ g }) => !search || `${g.case_id} ${g.title} ${g.question}`.toLowerCase().includes(search.toLowerCase()))
  const open = (i: number) => { const g = rows[i]?.g; if (g) nav(`/trials/${(g.firstFailing ?? g.trials[0]).id}`, { viewTransition: true }) }
  const [active] = useListNav(rows.length, open)
  const kinds = Object.entries(s.failures).map(([key, value]) => ({ key, label: FAILURE_LABELS[key] ?? key, value })).sort((a, b) => b.value - a.value)
  if (kinds.length === 0 && failingAll.length === 0 && !q.isLoading) return <Empty title="No failures">Every scored try passed its gating checks. The Metrics tab shows checks that did not apply or could not run.</Empty>
  const toggle = (k: string) => setParams((p) => { if (selected === k) p.delete('failure'); else { p.set('failure', k); p.delete('stage'); p.delete('cause') } return p })
  const clear = () => setParams((p) => { p.delete('failure'); p.delete('stage'); p.delete('cause'); return p })
  const causeLabel = cause ? causes.data?.causes?.find((c) => c.cause === cause)?.label ?? cause : null
  return (
    <div className="space-y-4" data-tour="failures">
      <div className="flex flex-wrap items-center gap-2.5">
        <Segmented size="sm" label="Which failures" value={mode} onChange={setMode} options={[
          { id: 'all', label: `All failing · ${failingAll.length}` },
          ...(baseId ? [{ id: 'changed' as const, label: `Changed vs #${baseId} · ${failingAll.filter(changed).length}` }] : []),
        ]} />
        <div className="relative"><Search className="absolute left-2 top-2 size-4 text-ink-3" /><Input className="w-60 pl-7" placeholder="Search questions" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search failing questions" /></div>
        <Help title="Failing questions"><p>One row per failing question, worst first; the colour on the left is its likely cause, and the small code beside the cause is the first check that failed.{baseId ? ` Changed vs #${baseId} keeps questions whose result moved since that run.` : ''}</p><p>The kinds below filter by what went wrong; a try counts once for each kind it shows, so they add up to more than the failed tries.</p><p>J and K move between rows, Enter opens the answer.</p></Help>
        <span className="ml-auto font-mono text-xs text-ink-3">{rows.length} questions · {s.failed_trials} failed tries</span>
      </div>
      {kinds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="failure-kinds">
          <span className="t-label mr-1">Kind</span>
          {kinds.map((k) => (
            <button key={k.key} type="button" onClick={() => toggle(k.key)} aria-pressed={selected === k.key}
              className={clsx('inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors', selected === k.key ? 'border-ink bg-surface-2 text-ink' : 'border-line-strong text-ink-2 hover:bg-surface-2')}>
              {k.label}<span className="num font-mono text-ink-3">{k.value}</span>
            </button>
          ))}
          {cause && <Badge tone="accent">Cause: {causeLabel}</Badge>}
          {stage && <Badge tone="accent">Stage: {stage}</Badge>}
          {(selected || stage || cause) && <Button size="sm" variant="ghost" onClick={clear}>Clear filter</Button>}
        </div>
      )}
      {q.isLoading ? <Loading /> : (
        <Table>
          <thead><tr><th className="w-[38%]">Question</th><th>Tries</th><th>Likely cause</th>{baseId && <th className="text-right">#{baseId} → now</th>}<th className="text-right">Speed</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5}><div className="flex flex-col items-center gap-2 py-8 text-ink-3"><GaugeArt size={48} />No failing question matches. Suspiciously quiet.</div></td></tr>}
            {rows.map(({ g, v, rate, b }, i) => {
              const col = v ? causeColor(v.cause) : 'transparent'
              const failedN = g.decided - g.passed
              return (
                <tr key={g.case_id} data-kb-index={i} data-case={g.case_id} data-cause={v?.cause ?? ''} onClick={() => open(i)}
                  className={clsx('cursor-pointer align-top hover:bg-surface-2/60', active === i && 'kb-active')}>
                  <td style={{ boxShadow: `inset 3px 0 0 ${col}` }} className="!pl-3">
                    <div className="flex items-baseline gap-2">
                      <Link className="font-mono text-xs text-accent-ink hover:underline" to={`/trials/${(g.firstFailing ?? g.trials[0]).id}`} onClick={(e) => e.stopPropagation()}>{g.case_id}</Link>
                      <span className="font-medium">{g.title}</span>
                    </div>
                    {g.question && <div className="mt-0.5 text-sm text-ink-2">{g.question}</div>}
                  </td>
                  <td className="whitespace-nowrap">
                    <div className="flex items-center gap-2"><DotStrip statuses={g.statuses} /><span className="text-xs text-ink-3">{rate === 0 ? 'every try' : `${failedN} of ${g.decided} · flaky`}</span></div>
                  </td>
                  <td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {v ? (
                        <span className="inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-xs font-medium" style={{ borderColor: col, color: col }}
                          title={v.source === 'you' ? 'Set by you' : v.source === 'ai' ? 'Explained by a grading model' : 'Found by the rules'}>
                          <span className="size-1.5 rounded-full" style={{ background: col }} />{v.label}
                        </span>
                      ) : g.failure_types[0] ? <Badge tone="bad">{FAILURE_LABELS[g.failure_types[0]] ?? g.failure_types[0]}</Badge> : <span className="text-ink-3">–</span>}
                      {g.failed_evaluators[0] && <span className="font-mono text-xs text-ink-3">{g.failed_evaluators[0]}</span>}
                    </div>
                  </td>
                  {baseId && (
                    <td className="whitespace-nowrap text-right text-xs">
                      {b === null ? <span className="text-ink-3">new</span> : Math.abs(b - rate) < 1e-9 ? <span className="text-ink-3">same</span>
                        : <span className="num font-mono">{pct(b, 0)} → {pct(rate, 0)} <Delta value={rate - b} format={() => ''} /></span>}
                    </td>
                  )}
                  <td className="num whitespace-nowrap text-right font-mono text-xs">{ms(g.latency_ms)}</td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      )}
    </div>
  )
}

const KIND_LABEL: Record<string, string> = { deterministic: 'Objective checks', retrieval: 'Retrieval', agent: 'Agent / tools', performance: 'Latency and cost', llm_judge: 'Meaning (grading model)' }
const METRICS_HELP = <><p>Pass rates count only tries where the check reached a verdict.</p><p>"Not applicable": the question does not ask for it. "Not evaluated": the bot did not report what the check needs.</p></>

function MetricsTab({ s, heuristic }: { s: RunSummary; heuristic: boolean }) {
  const evs = useQuery({ queryKey: ['evaluators'], queryFn: () => api.get<{ evaluators: EvaluatorInfo[] }>('/api/evaluators') })
  const info = Object.fromEntries((evs.data?.evaluators ?? []).map((e) => [e.id, e]))
  const kinds = [...new Set(Object.values(s.evaluators).map((m) => m.kind))]
  const fmtMean = (id: string, v: number | null) => (v === null ? 'n/a' : id === 'latency' ? ms(v) : id === 'token_budget' ? num(v) : id === 'cost_budget' ? usd(v) : v.toFixed(2))
  const skipped = (c: Partial<Record<string, number>>) => {
    const parts = [[c.not_applicable, 'not applicable'], [c.not_evaluated, 'not evaluated'], [c.unknown, 'unknown'], [c.error, 'error']].filter(([n]) => n) as [number, string][]
    return parts.length ? parts.map(([n, w]) => `${n} ${w}`).join(', ') : '-'
  }
  return (
    <div className="space-y-10">
      {kinds.map((kind) => (
        <Card key={kind} title={KIND_LABEL[kind] ?? kind} padded={false}
          help={<>{kind === 'llm_judge' && heuristic && <p>This run used the heuristic judge: these are word-overlap scores, hatched, not a model's reading of meaning.</p>}{METRICS_HELP}</>}>
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
                      <span className="ml-1.5 font-mono text-label text-ink-3">v{m.version}</span>
                      {info[id]?.calibration && <div className="text-xs text-ink-3">{heur ? 'heuristic judge' : info[id].calibration!.status}</div>}
                    </td>
                    <td className="num text-right font-mono">{pct(m.pass_rate)}</td>
                    <td><IntervalBar value={m.pass_rate} low={m.ci_low} high={m.ci_high} axis /></td>
                    <td className="num text-right font-mono">{fmtMean(id, m.mean_score)}</td>
                    <td className="num text-right font-mono">{m.n_decided}</td>
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
    <div className="grid gap-8 lg:grid-cols-[320px_minmax(0,1fr)]">
      <Card title="Tries" padded={false} meta={<SampleSize n={shown.length} unit="tries" />}
        help={<p>Every try of the run. Click one, or move with J and K, to see its trace; Enter opens the answer.</p>}
        actions={<label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" checked={onlyFailing} onChange={(e) => setOnlyFailing(e.target.checked)} className="accent-[var(--accent)]" />failing only</label>}>
        <ul className="scroll-thin max-h-[680px] overflow-y-auto">
          {shown.map((t, i) => (
            <li key={t.id}>
              <button type="button" data-kb-index={i} data-case={t.case_id} onClick={() => setActive(i)} className={clsx('flex w-full items-center gap-2 border-b border-line px-3 py-1.5 text-left text-xs hover:bg-surface-2', pick === t.id && 'kb-active')}>
                <span className={clsx('size-2 shrink-0 rounded-full', t.status === 'passed' ? 'bg-good' : t.status === 'error' ? 'bg-error' : 'bg-bad')} />
                <span className="font-mono">{t.case_id}</span><span className="text-ink-3">try {t.trial_index + 1}</span><span className="num ml-auto font-mono text-ink-3">{ms(t.latency_ms)}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={trial.data ? <>Trace · <span className="font-mono">{trial.data.case_id}</span> try {trial.data.trial_index + 1}</> : 'Trace'} actions={pick && <Button size="sm" onClick={() => nav(`/trials/${pick}`, { viewTransition: true })}>Open trial</Button>}>
        {pick === null ? <p className="text-sm text-ink-3">No tries recorded.</p> : trial.isLoading ? <Loading /> : trial.data?.trace ? (
          <div className="space-y-3">
            <div className="text-lead"><span className="t-label mr-2">Question</span>{trial.data.question}</div>
            <TraceViewer spans={trial.data.trace.spans} />
            <div className="rounded-lg bg-surface-2/60 p-3 text-base"><span className="t-label mr-2">Answer</span>{trial.data.answer}</div>
          </div>
        ) : <p className="text-sm text-ink-3">No trace stored.</p>}
      </Card>
    </div>
  )
}

function ConfigTab({ r }: { r: RunDetail }) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const models = useQuery({ queryKey: ['models'], queryFn: () => api.get<ProviderConfig[]>('/api/models') })
  const [judge, setJudge] = useState('')
  const regradeBody = () => (judge ? { judge: judge === 'heuristic' ? { provider: 'heuristic' } : { provider_config_id: Number(judge) }, name: `${r.experiment} (re-graded)` } : {})
  const long = useLongWork()
  const reeval = useMutation({
    mutationFn: () => api.post<RunHeader>(`/api/runs/${r.id}/reevaluate`, regradeBody()),
    meta: { silent: true },
    onSuccess: (n) => { qc.invalidateQueries({ queryKey: ['runs'] }); nav(`/runs/${n.id}`, { viewTransition: true }) },
  })
  return (
    <div className="space-y-10">
      <Card title="Re-grade these answers"
        help={<><p>Grade the stored answers again without asking the bot: after changing a rubric, a threshold, or to see what a different grading model says.</p><p>The result is a new run linked to this one; this run keeps its grades.</p></>}>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Grading model">
            <Select className="w-72" value={judge} onChange={(e) => setJudge(e.target.value)} aria-label="Re-grade with">
              <option value="">Same as this run ({r.judge ? r.judge.model : 'none'})</option>
              <option value="heuristic">Heuristic (word overlap)</option>
              {(models.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.name} ({whereLabel(m)})</option>)}
            </Select>
          </Field>
          <Button variant="primary" loading={reeval.isPending || long.checking} onClick={() => long.run(() => api.post<{ seconds?: number }>(`/api/runs/${r.id}/reevaluate`, { ...regradeBody(), estimate_only: true }), () => reeval.mutate())}><RotateCcw className="size-3.5" /> Re-grade</Button>
        </div>
        {reeval.isError && <div className="mt-2"><ErrorState error={reeval.error} /></div>}
      </Card>
      {long.dialog}
      <Card title="Snapshot"
        help={<p>Everything this run used, frozen at launch: connection configuration and version, dataset version and content hash, check versions, grading model and rubric hashes, and the run settings.</p>}>
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
