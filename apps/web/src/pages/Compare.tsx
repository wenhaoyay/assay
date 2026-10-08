import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowDownRight, ArrowLeftRight, ArrowUpRight, Minus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CompareCauses } from '../components/Causes'
import { Bootstrap } from '../components/compare/Bootstrap'
import { Changed, Dumbbell } from '../components/compare/Changed'
import { Hero } from '../components/compare/Hero'
import { Power } from '../components/compare/Power'
import { Replay } from '../components/compare/Replay'
import { RunPicker } from '../components/compare/RunPicker'
import { SampleSize } from '../components/instrument'
import { ShareMenu } from '../components/Share'
import { Badge, Card, Empty, ErrorState, Loading, Notice, PageSkeleton, Segmented, Table, Term } from '../components/ui'
import { Confetti, DeltaList, ForestPlot } from '../components/viz'
import { api } from '../lib/api'
import { direction, fmtDelta, fmtValue, pairCases, reading } from '../lib/compare'
import { useCrumbs } from '../lib/crumbs'
import { pct } from '../lib/format'
import type { Comparison, ComparisonRow, EvaluatorInfo, RunHeader, TrialRow } from '../lib/types'

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
              <td>{r.label}</td>
              <td className="num text-right font-mono">{fmtValue(r, r.baseline)}</td>
              <td className="num text-right font-mono">{fmtValue(r, r.candidate)}</td>
              <td className={clsx('num text-right font-mono', d === 'better' && 'text-good-ink', d === 'worse' && 'text-bad-ink')}>
                {/* Arrow = which way the number moved; colour = better or worse. */}
                <span className="inline-flex items-center gap-1"><Icon className="size-3.5" aria-label={r.delta === null ? 'n/a' : r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : 'same'} />{fmtDelta(r)}</span>
              </td>
              <td className="num whitespace-nowrap text-right font-mono text-xs text-ink-2">
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
    const cand = candidate ? done.find((r) => r.id === candidate) : done.find((r) => !r.off_topic) ?? done[0]
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
      <div className="flex flex-wrap items-center gap-3 max-md:flex-col max-md:items-stretch" data-testid="run-pickers">
        <RunPicker runs={done} value={baseline} onChange={(v) => set('baseline', v)} side="baseline" />
        <button type="button" title="Swap baseline and candidate" aria-label="Swap baseline and candidate" onClick={() => baseline && candidate && setParams({ baseline: String(candidate), candidate: String(baseline) })}
          className="flex size-8 shrink-0 items-center justify-center self-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink"><ArrowLeftRight className="size-4" /></button>
        <RunPicker runs={done} value={candidate} onChange={(v) => set('candidate', v)} side="candidate" />
      </div>
      {done.length < 2 ? (
        <div className="mt-8"><Empty title="Two finished runs are needed to compare">Run a baseline and a candidate on the same questions (<code className="font-mono">gaugelab seed --run</code> does this for the Acme demo), then pick them above.</Empty></div>
      ) : !baseline || !candidate ? (
        <div className="mt-8"><Empty title="Pick a baseline and a candidate">Choose two runs above; the same questions are paired between them.</Empty></div>
      ) : baseline === candidate ? <div className="mt-6"><Notice tone="warn" title="Pick two different runs" /></div>
        : cmp.isLoading ? <div className="mt-8"><Loading label="Comparing" rows={8} /></div>
          : cmp.isError ? <div className="mt-6"><ErrorState error={cmp.error} /></div>
            : cmp.data && <CompareView key={`${baseline}-${candidate}`} c={cmp.data} />}
    </>
  )
}

function CompareView({ c }: { c: Comparison }) {
  const evs = useQuery({ queryKey: ['evaluators'], queryFn: () => api.get<{ evaluators: EvaluatorInfo[]; judges: string[] }>('/api/evaluators') })
  const issues = useQuery({ queryKey: ['comparability', c.candidate_run.id, c.baseline_run.id], queryFn: () => api.get<{ issues: string[] }>(`/api/runs/${c.candidate_run.id}/comparability?other=${c.baseline_run.id}`) })
  const sides = useQuery({
    queryKey: ['side-by-side', c.baseline_run.id, c.candidate_run.id],
    queryFn: async () => Promise.all([c.baseline_run, c.candidate_run].map((r) => api.get<TrialRow[]>(`/api/runs/${r.id}/trials`))),
  })
  const [view, setView] = useState<'picture' | 'table'>('picture')
  const judgeIds = new Set(evs.data?.judges ?? [])
  const anyHeuristic = [c.baseline_run, c.candidate_run].some((r) => r.judge?.provider === 'heuristic')
  const isHeuristic = (metric: string) => anyHeuristic && (judgeIds.has(metric) || /\(judge\)$/.test(c.metrics.find((m) => m.metric === metric)?.label ?? ''))
  const overall = c.metrics.find((m) => m.metric === 'overall_pass_rate') ?? null
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
  const cases = useMemo(() => (sides.data ? pairCases(sides.data[0], sides.data[1]) : []), [sides.data])
  const diffs = useMemo(() => cases.filter((x) => x.a?.total && x.b?.total).map((x) => x.d), [cases])
  const mc = c.mcnemar
  const nPaired = mc.both_pass + mc.both_fail + mc.only_baseline + mc.only_candidate
  const flipShare = nPaired ? (mc.only_baseline + mc.only_candidate) / nPaired : 0

  // Speed figures from runs that asked a different number of questions at a time are not comparable.
  const loadDiffers = !!c.baseline_run.concurrency && !!c.candidate_run.concurrency && c.baseline_run.concurrency !== c.candidate_run.concurrency
  const offTopic = [c.baseline_run, c.candidate_run].filter((r) => r.off_topic)
  const rateRows = c.metrics.filter((m) => m.unit === 'rate')
  const onlyOne = c.only_in_baseline.length + c.only_in_candidate.length

  return (
    <div className="space-y-12">
      <Confetti fire={celebrate} />
      <Hero c={c} actions={<ShareMenu runId={c.candidate_run.id} baselineId={c.baseline_run.id} />} />

      {((issues.data?.issues.length ?? 0) > 0 || loadDiffers || offTopic.length > 0 || onlyOne > 0) && (
        <div className="-mt-4 space-y-2">
          {offTopic.map((r) => (
            <Notice key={r.id} tone="warn" title={<>Run <span className="font-mono">#{r.id}</span> asked {r.off_topic}'s questions</>}>
              Its questions were written for another chatbot, so its pass rate says little about this one. Compare runs that asked this chatbot's own questions.
            </Notice>
          ))}
          {(issues.data?.issues.length ?? 0) > 0 && (
            <Notice tone="warn" title="These runs differ in more than the chatbot version">
              <ul className="list-disc space-y-0.5 pl-4">{issues.data!.issues.map((x) => <li key={x}>{x}</li>)}</ul>
            </Notice>
          )}
          {loadDiffers && (
            <Notice tone="warn" title={<>Run <span className="font-mono">#{c.baseline_run.id}</span> asked <span className="font-mono">{c.baseline_run.concurrency}</span> at a time, run <span className="font-mono">#{c.candidate_run.id}</span> asked <span className="font-mono">{c.candidate_run.concurrency}</span></>}>
              The latency difference may be load, not the bot: questions asked together wait for each other. Speed rows are marked; compare speed only between runs at the same setting (pass rates are unaffected).
            </Notice>
          )}
          {onlyOne > 0 && (
            <Notice title={<>Only the <span className="font-mono">{c.n_shared_cases}</span> questions both runs asked are compared</>}>
              {c.only_in_baseline.length > 0 && <>Only #{c.baseline_run.id} asked <span className="font-mono">{c.only_in_baseline.length}</span>. </>}
              {c.only_in_candidate.length > 0 && <>Only #{c.candidate_run.id} asked <span className="font-mono">{c.only_in_candidate.length}</span>.</>}
            </Notice>
          )}
        </div>
      )}

      {sides.isError ? <ErrorState error={sides.error} /> : !sides.data ? <div className="skeleton h-28" /> : (
        <Replay cases={cases} baseId={c.baseline_run.id} candId={c.candidate_run.id} />
      )}

      <div className="grid gap-x-10 gap-y-12 xl:grid-cols-2">
        {sides.data ? <Changed cases={cases} c={c} baseTrials={sides.data[0]} candTrials={sides.data[1]} /> : <div className="skeleton h-60" />}
        <Card title="Every metric" meta={<SampleSize n={c.n_shared_cases} unit="paired" />}
          help={<>
            <p>The change in each check, with its 95% interval from resampling questions. A line clear of the zero mark is a real change; one crossing zero could be noise.</p>
            <p>Hatched rows were scored by the word-overlap heuristic, not a model: a cheap signal that cannot see paraphrase. Re-grade both runs with a grading model to judge meaning.</p>
            <p>Speed, tokens and cost below are measured once, with no interval: the arrow is which way the number moved, the colour whether that is better or worse.</p>
          </>}
          actions={<Segmented size="sm" value={view} onChange={setView} options={[{ id: 'picture', label: 'Picture' }, { id: 'table', label: 'Table' }]} />}>
          {view === 'picture' ? (
            <div className="space-y-6">
              <ForestPlot rows={rateRows} isHeuristic={isHeuristic} />
              <div>
                <div className="t-label mb-1.5"><Term k="point_estimate">Measured once</Term></div>
                <DeltaList rows={c.metrics} caution={loadDiffers ? (m) => /latency/.test(m) : undefined} />
              </div>
            </div>
          ) : <MetricTable rows={c.metrics} />}
        </Card>
      </div>

      {c.causes && <CompareCauses fixed={c.causes.fixed} broke={c.causes.broke} baseline={c.baseline_run.id} candidate={c.candidate_run.id} />}

      {diffs.length > 1 && <Bootstrap diffs={diffs} nQuestions={diffs.length} />}
      {nPaired > 0 && <Power flipShare={flipShare} n0={diffs.length || c.n_shared_cases} />}

      <div className="grid gap-x-10 gap-y-12 xl:grid-cols-2">
        <Card title="Pass rate by category" help={<><p>Each category's pass rate in both runs: the blue dot is #{c.baseline_run.id}, the orange dot #{c.candidate_run.id}.</p><p>Small categories move a lot from one question: read the question count before the change.</p></>}>
          <ul className="divide-y divide-line">
            {c.by_category.map((r) => (
              <li key={r.category} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm">{r.category.replace(/_/g, ' ')}</span>
                <SampleSize n={r.n} min={10} />
                <span className="num w-24 text-right font-mono text-xs text-ink-3">{pct(r.baseline, 0)} → {pct(r.candidate, 0)}</span>
                <span className="max-sm:hidden"><Dumbbell a={r.baseline} b={r.candidate} /></span>
                <span className={clsx('num w-16 text-right font-mono text-sm', (r.delta ?? 0) > 0 && 'text-good-ink', (r.delta ?? 0) < 0 && 'text-bad-ink', !r.delta && 'text-ink-3')}>
                  {r.delta === null ? 'n/a' : `${r.delta > 0 ? '+' : r.delta < 0 ? '−' : ''}${Math.abs(r.delta * 100).toFixed(1)}pp`}
                </span>
              </li>
            ))}
          </ul>
        </Card>
        {c.score_changes.length > 0 && (
          <Card title="Large score changes" meta={c.score_changes.length} help={<><p>Single checks whose score moved by 0.25 or more on a question, in either direction.</p><p>Hatched rows were scored by the word-overlap heuristic.</p></>}>
            <div className="scroll-thin max-h-[420px] overflow-y-auto">
              <Table>
                <thead><tr><th>Question</th><th>Check</th><th className="text-right">Baseline</th><th className="text-right">Candidate</th></tr></thead>
                <tbody>{c.score_changes.slice(0, 50).map((s) => (
                  <tr key={s.case_id + s.evaluator_id} data-case={s.case_id} className={clsx(isHeuristic(s.evaluator_id) && 'hatched')}>
                    <td className="font-mono text-xs">{s.case_id}</td><td>{s.evaluator_id}</td>
                    <td className="num text-right font-mono">{s.baseline.toFixed(3)}</td>
                    <td className={clsx('num text-right font-mono', s.candidate > s.baseline ? 'text-good-ink' : 'text-bad-ink')}>{s.candidate.toFixed(3)}</td>
                  </tr>
                ))}</tbody>
              </Table>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}
