import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, Check, ChevronDown, ChevronRight, Minus, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { PairedBars } from '../components/charts'
import { ShareMenu } from '../components/Share'
import { Confetti, DeltaList, ForestPlot, VerdictNeedle } from '../components/viz'
import { Badge, Card, DotStrip, Empty, ErrorState, Explain, Input, Loading, Notice, PageHeader, PageSkeleton, Segmented, StatusBadge, Table, Term } from '../components/ui'
import { api } from '../lib/api'
import { direction, fmtDelta, fmtValue, reading, verdictSentence } from '../lib/compare'
import { useCrumbs } from '../lib/crumbs'
import { FAILURE_LABELS, pct } from '../lib/format'
import type { CaseChange, Comparison, ComparisonRow, EvaluatorInfo, RunHeader, TrialRow } from '../lib/types'
import { HighlightedAnswer } from './Trial'

export function MetricTable({ rows }: { rows: ComparisonRow[] }) {
  return (
    <Table>
      <thead>
        <tr><th>Metric</th><th className="text-right">Baseline</th><th className="text-right">Candidate</th><th className="text-right">Change</th><th className="text-right">95% interval of the change</th><th>Reading</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const d = direction(r)
          const read = reading(r)
          const Icon = r.delta === null || r.delta === 0 ? Minus : r.delta > 0 ? ArrowUpRight : ArrowDownRight
          return (
            <tr key={r.metric} data-testid={`metric-${r.metric}`}>
              <td className="font-medium">{r.label}</td>
              <td className="num text-right">{fmtValue(r, r.baseline)}</td>
              <td className="num text-right">{fmtValue(r, r.candidate)}</td>
              <td className={clsx('num text-right font-medium', d === 'better' && 'text-good-ink', d === 'worse' && 'text-bad-ink')}>
                {/* Arrow = which way the number moved; colour = better or worse. */}
                <span className="inline-flex items-center gap-1"><Icon className="size-3.5" aria-label={r.delta === null ? 'n/a' : r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : 'same'} />{fmtDelta(r)}</span>
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

function RunPicker({ runs, value, onChange, side }: { runs: RunHeader[]; value: number | null; onChange: (id: number) => void; side: 'baseline' | 'candidate' }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const cur = runs.find((r) => r.id === value)
  const list = runs.filter((r) => !q || `${r.id} ${r.experiment} ${r.target} ${r.variant_label}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="relative min-w-0 flex-1" ref={ref}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-label={side} aria-expanded={open}
        className={clsx('flex w-full items-center gap-3 rounded-xl border bg-surface px-3 py-2.5 text-left shadow-card transition-colors hover:border-line-strong',
          side === 'baseline' ? 'border-series-1/40' : 'border-series-2/40')}>
        <span className={clsx('size-2.5 shrink-0 rounded-sm', side === 'baseline' ? 'bg-series-1' : 'bg-series-2')} />
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium uppercase tracking-wide text-ink-3">{side}</span>
          {cur ? (
            <>
              <span className="block truncate text-[13px] font-medium"><span className="font-mono">#{cur.id}</span> {cur.experiment}</span>
              <span className="block truncate text-xs text-ink-3">{cur.target} v{cur.target_version} - {cur.variant_label} - {cur.n_cases} x {cur.trials_per_case} - judge {cur.judge ? (cur.judge.provider === 'heuristic' ? 'heuristic' : cur.judge.model) : 'none'}</span>
            </>
          ) : <span className="block text-[13px] text-ink-3">Choose a run...</span>}
        </span>
        {cur?.gate_status && <StatusBadge status={cur.gate_status} />}
        <ChevronDown className="size-4 text-ink-3" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.12 }}
            className="absolute z-30 mt-1 w-full min-w-[340px] rounded-xl border border-line bg-surface p-1.5 shadow-pop">
            <Input autoFocus placeholder="Filter runs" value={q} onChange={(e) => setQ(e.target.value)} className="mb-1" />
            <ul className="scroll-thin max-h-80 overflow-y-auto">
              {list.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => { onChange(r.id); setOpen(false) }}
                    className={clsx('w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-2', r.id === value && 'bg-accent-wash')}>
                    <div className="text-[13px]"><span className="font-mono text-xs">#{r.id}</span> {r.experiment}</div>
                    <div className="text-xs text-ink-3">{r.target} - {r.n_cases} cases - {pct(r.metrics.overall_pass_rate)} - judge {r.judge ? (r.judge.provider === 'heuristic' ? 'heuristic' : r.judge.model) : 'none'}</div>
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export function ComparePage() {
  const [params, setParams] = useSearchParams()
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs?limit=300') })
  const done = useMemo(() => (runs.data ?? []).filter((r) => r.status === 'completed' || r.status === 'completed_with_errors'), [runs.data])
  const baseline = Number(params.get('baseline')) || null
  const candidate = Number(params.get('candidate')) || null
  useCrumbs([{ label: 'Compare' }, ...(baseline && candidate ? [{ label: `#${baseline} vs #${candidate}` }] : [])], `compare-${baseline}-${candidate}`)

  useEffect(() => {
    // Default: the newest completed run as candidate, the newest earlier comparable run as baseline.
    if (!done.length || (baseline && candidate)) return
    const cand = candidate ? done.find((r) => r.id === candidate) : done[0]
    const base = done.find((r) => r.id !== cand?.id && r.comparability_key === cand?.comparability_key && r.id < (cand?.id ?? 0))
      ?? done.find((r) => r.id !== cand?.id && r.dataset === cand?.dataset && r.id < (cand?.id ?? 0)) ?? done.find((r) => r.id !== cand?.id)
    if (cand && base) setParams({ baseline: String(base.id), candidate: String(cand.id) }, { replace: true })
  }, [done, baseline, candidate, setParams])

  const cmp = useQuery({
    queryKey: ['compare', baseline, candidate],
    queryFn: () => api.get<Comparison>(`/api/runs/compare?baseline=${baseline}&candidate=${candidate}`),
    enabled: !!baseline && !!candidate && baseline !== candidate,
  })
  const set = (k: 'baseline' | 'candidate', v: number) => setParams((p) => { p.set(k, String(v)); return p })

  if (runs.isLoading) return <PageSkeleton />
  return (
    <>
      <PageHeader title="Compare" description="Baseline against candidate on the same questions. Changes are paired by question; intervals come from resampling questions."
        actions={baseline && candidate ? <ShareMenu runId={candidate} baselineId={baseline} /> : null} />
      <div className="mb-5 flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch">
        <RunPicker runs={done} value={baseline} onChange={(v) => set('baseline', v)} side="baseline" />
        <button type="button" title="Swap" aria-label="Swap baseline and candidate" onClick={() => baseline && candidate && setParams({ baseline: String(candidate), candidate: String(baseline) })}
          className="flex size-8 shrink-0 items-center justify-center self-center rounded-full border border-line bg-surface text-ink-3 hover:text-ink"><ArrowLeftRight className="size-4" /></button>
        <RunPicker runs={done} value={candidate} onChange={(v) => set('candidate', v)} side="candidate" />
      </div>
      {done.length < 2 ? (
        <Empty title="Two completed runs are needed">Run a baseline and a candidate on the same dataset (<code>gaugelab seed --run</code> does this for the Acme demo).</Empty>
      ) : baseline === candidate ? <Notice tone="warn" title="Pick two different runs" /> : cmp.isLoading ? <Loading label="Comparing" rows={8} /> : cmp.isError ? <ErrorState error={cmp.error} /> : cmp.data && <CompareView c={cmp.data} />}
    </>
  )
}

function CompareView({ c }: { c: Comparison }) {
  const evs = useQuery({ queryKey: ['evaluators'], queryFn: () => api.get<{ evaluators: EvaluatorInfo[]; judges: string[] }>('/api/evaluators') })
  const issues = useQuery({ queryKey: ['comparability', c.candidate_run.id, c.baseline_run.id], queryFn: () => api.get<{ issues: string[] }>(`/api/runs/${c.candidate_run.id}/comparability?other=${c.baseline_run.id}`) })
  const [view, setView] = useState<'picture' | 'table'>('picture')
  const judgeIds = new Set(evs.data?.judges ?? [])
  const anyHeuristic = [c.baseline_run, c.candidate_run].some((r) => r.judge?.provider === 'heuristic')
  const isHeuristic = (metric: string) => anyHeuristic && judgeIds.has(metric)
  const overall = c.metrics.find((m) => m.metric === 'overall_pass_rate') ?? null
  const verdict = verdictSentence({ overall, regressions: c.regressions.length, improvements: c.improvements.length, rows: c.metrics })
  const mc = c.mcnemar
  const win = reading(overall ?? ({ delta: null } as ComparisonRow)).text === 'likely better'
  const [celebrate] = useState(() => {
    if (!win) return false
    try {
      const k = `gl-confetti-${c.baseline_run.id}-${c.candidate_run.id}`
      if (localStorage.getItem(k)) return false
      localStorage.setItem(k, '1')
      return true
    } catch {
      return false
    }
  })

  return (
    <div className="space-y-5">
      <Confetti fire={celebrate} />
      {(issues.data?.issues.length ?? 0) > 0 && (
        <Notice tone="warn" title="These runs differ in more than the chatbot version">
          <ul className="list-disc space-y-0.5 pl-4">{issues.data!.issues.map((x) => <li key={x}>{x}</li>)}</ul>
        </Notice>
      )}
      <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-card" data-tour="verdict">
        <div className="grid items-center gap-5 p-5 md:grid-cols-[auto_minmax(0,1fr)]">
          <div className="flex flex-col items-center">
            <VerdictNeedle delta={overall?.delta ?? null} low={overall?.ci?.ci_low} high={overall?.ci?.ci_high} label={verdict.text} />
            <span className="flex w-[168px] justify-between px-2 text-[10px] text-ink-3"><span>worse</span><span>better</span></span>
            <span className="num mt-1 text-xs text-ink-3">pass rate {pct(overall?.baseline)} → <b className="text-ink">{pct(overall?.candidate)}</b></span>
          </div>
          <div>
            <div className="text-xs font-medium text-ink-3">{c.n_shared_cases} questions in both runs</div>
            <p className={clsx('mt-1 text-[18px] font-semibold leading-snug', verdict.tone === 'good' && 'text-good-ink', verdict.tone === 'bad' && 'text-bad-ink')} data-testid="verdict">{verdict.text}</p>
            <p className="mt-2 text-[13px] text-ink-2">
              Of {mc.both_pass + mc.both_fail + mc.only_baseline + mc.only_candidate} questions, {mc.both_pass} pass in both and {mc.both_fail} fail in both;
              {' '}<b className="text-bad-ink">{mc.only_baseline}</b> passed only before and <b className="text-good-ink">{mc.only_candidate}</b> pass only now.
              {' '}<Term k="mcnemar">McNemar</Term> {mc.p_value === null ? 'n/a' : `p = ${mc.p_value.toFixed(3)}`}
              {mc.p_value !== null && (mc.p_value < 0.05 ? ' - a split this lopsided is unlikely by chance.' : ' - a split like this often happens by chance.')}
            </p>
            <Explain className="mt-2">The needle shows the change in pass rate; the grey arc is its 95% interval. If the arc covers the middle, the versions may really be equally good.</Explain>
          </div>
        </div>
      </section>

      {anyHeuristic && (
        <Notice title={<>Hatched rows come from the <Term k="heuristic">heuristic judge</Term></>}>
          They were scored by word overlap with the reference, not by an LLM: a cheap signal that cannot see paraphrase. Re-grade both runs with a grading model for meaning.
        </Notice>
      )}

      <Card title="Every metric" subtitle={`${c.n_shared_cases} paired questions`} padded={false}
        actions={<Segmented size="sm" value={view} onChange={setView} options={[{ id: 'picture', label: 'Picture' }, { id: 'table', label: 'Table' }]} />}>
        {view === 'picture' ? (
          <div className="space-y-5 p-4">
            <ForestPlot rows={c.metrics} isHeuristic={isHeuristic} />
            <div>
              <div className="mb-1.5 text-xs font-medium text-ink-3"><Term k="point_estimate">Measured once</Term> (no interval): arrow = which way it moved, colour = better or worse</div>
              <DeltaList rows={c.metrics} />
            </div>
          </div>
        ) : <MetricTable rows={c.metrics} />}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={<span className="text-bad-ink">Regressed: passed more often before ({c.regressions.length})</span>} padded={false}>
          <CaseList items={c.regressions} c={c} kind="regression" />
        </Card>
        <Card title={<span className="text-good-ink">Improved: pass more often now ({c.improvements.length})</span>} padded={false}>
          <CaseList items={c.improvements} c={c} kind="improvement" />
        </Card>
      </div>

      <Card title="Pass rate by category">
        <PairedBars data={c.by_category.map((r) => ({ group: r.category, baseline: r.baseline, candidate: r.candidate, n: r.n }))} />
        <Table className="mt-3">
          <thead><tr><th>Category</th><th className="text-right">Cases</th><th className="text-right">Baseline</th><th className="text-right">Candidate</th><th className="text-right">Change</th></tr></thead>
          <tbody>
            {c.by_category.map((r) => (
              <tr key={r.category}>
                <td>{r.category}</td><td className="num text-right">{r.n}</td><td className="num text-right">{pct(r.baseline)}</td><td className="num text-right">{pct(r.candidate)}</td>
                <td className={clsx('num text-right font-medium', (r.delta ?? 0) > 0 && 'text-good-ink', (r.delta ?? 0) < 0 && 'text-bad-ink')}>{r.delta === null ? 'n/a' : `${r.delta > 0 ? '+' : ''}${(r.delta * 100).toFixed(1)}pp`}</td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="mt-2 text-xs text-ink-3">Small categories move a lot from one question: read the case count before the change.</p>
      </Card>
      {c.score_changes.length > 0 && (
        <Card title={`Large score changes (|change| >= 0.25, ${c.score_changes.length})`} padded={false}>
          <Table>
            <thead><tr><th>Case</th><th>Check</th><th className="text-right">Baseline</th><th className="text-right">Candidate</th></tr></thead>
            <tbody>{c.score_changes.slice(0, 50).map((s) => <tr key={s.case_id + s.evaluator_id} className={clsx(isHeuristic(s.evaluator_id) && 'hatched')}><td className="font-mono text-xs">{s.case_id}</td><td>{s.evaluator_id}</td><td className="num text-right">{s.baseline.toFixed(3)}</td><td className="num text-right">{s.candidate.toFixed(3)}</td></tr>)}</tbody>
          </Table>
        </Card>
      )}
    </div>
  )
}

function CaseList({ items, c, kind }: { items: CaseChange[]; c: Comparison; kind: 'regression' | 'improvement' }) {
  const [open, setOpen] = useState<string | null>(null)
  if (!items.length) return <p className="p-4 text-[13px] text-ink-3">None.</p>
  return (
    <ul className="divide-y divide-line">
      {items.map((x) => (
        <li key={x.case_id}>
          <button type="button" onClick={() => setOpen(open === x.case_id ? null : x.case_id)} aria-expanded={open === x.case_id}
            className="flex w-full items-start gap-2 px-4 py-2.5 text-left hover:bg-surface-2">
            <ChevronRight className={clsx('mt-0.5 size-4 shrink-0 text-ink-3 transition-transform', open === x.case_id && 'rotate-90')} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-[13px]"><span className="font-mono text-xs">{x.case_id}</span><span className="truncate">{x.title}</span><Badge className="ml-auto">{x.category}</Badge></span>
              <span className="num mt-0.5 block text-xs text-ink-2">
                pass rate {pct(x.baseline_pass_rate, 0)} → <span className={kind === 'regression' ? 'text-bad-ink' : 'text-good-ink'}>{pct(x.candidate_pass_rate, 0)}</span>
                {kind === 'regression' && x.candidate_failure_types.length > 0 && <> - now: {x.candidate_failure_types.map((f) => FAILURE_LABELS[f] ?? f).join(', ')}</>}
                {kind === 'improvement' && x.baseline_failure_types.length > 0 && <> - was: {x.baseline_failure_types.map((f) => FAILURE_LABELS[f] ?? f).join(', ')}</>}
              </span>
            </span>
          </button>
          <AnimatePresence initial={false}>
            {open === x.case_id && (
              <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                <SideBySide caseId={x.case_id} c={c} />
              </motion.div>
            )}
          </AnimatePresence>
        </li>
      ))}
    </ul>
  )
}

/** The same question in both runs: answers next to each other, with each side's failing checks. */
function SideBySide({ caseId, c }: { caseId: string; c: Comparison }) {
  const sides = [c.baseline_run, c.candidate_run]
  const trials = useQuery({
    queryKey: ['side-by-side', c.baseline_run.id, c.candidate_run.id],
    queryFn: async () => Promise.all(sides.map((r) => api.get<TrialRow[]>(`/api/runs/${r.id}/trials`))),
  })
  const detail = useQuery({
    queryKey: ['side-by-side-case', caseId, c.baseline_run.id, c.candidate_run.id],
    queryFn: async () => {
      const [a, b] = trials.data!
      const pick = (ts: TrialRow[]) => ts.filter((t) => t.case_id === caseId).sort((x, y) => (x.status === 'passed' ? 1 : 0) - (y.status === 'passed' ? 1 : 0))
      return [pick(a), pick(b)]
    },
    enabled: !!trials.data,
  })
  if (!detail.data) return <div className="px-4 pb-4"><div className="skeleton h-24" /></div>
  return (
    <div className="grid gap-3 bg-surface-2/50 px-4 py-3 md:grid-cols-2">
      {detail.data.map((ts, i) => (
        <div key={i} className="min-w-0 rounded-lg border border-line bg-surface p-3">
          <div className="mb-1.5 flex items-center gap-2 text-xs">
            <span className={clsx('size-2 rounded-sm', i === 0 ? 'bg-series-1' : 'bg-series-2')} />
            <span className="font-medium">{i === 0 ? 'Baseline' : 'Candidate'} #{sides[i].id}</span>
            <DotStrip statuses={ts.map((t) => t.status)} />
            {ts[0] && <Link to={`/trials/${ts[0].id}`} className="ml-auto text-accent-ink hover:underline">open try</Link>}
          </div>
          {ts[0] ? (
            <>
              <div className="line-clamp-6 whitespace-pre-wrap text-[13px] leading-relaxed"><HighlightedAnswer text={ts[0].answer} good={[]} bad={[]} /></div>
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
