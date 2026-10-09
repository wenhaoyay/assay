import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowRight, GitCompareArrows, Palette, Play } from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { FixFirst, NotesCard } from '../components/Causes'
import { CaseJourney, journeyCounts, SlopeChart, type JourneyFilter } from '../components/home/CaseJourney'
import { MetricSwitch, RunTimeline, type Metric } from '../components/home/RunTimeline'
import { dayLabel, spanWords, useGateThresholds, variantChange, type Point } from '../components/home/shared'
import { Needle, SampleSize } from '../components/instrument'
import { RunsTable } from '../components/RunsTable'
import { DeltaList, StagePipeline } from '../components/viz'
import { Badge, Card, Empty, ErrorState, PageHeader, PageSkeleton, PROJECT_COLORS, ProjectMark, Segmented, Select, Term, linkButton } from '../components/ui'
import { api } from '../lib/api'
import { verdictSentence } from '../lib/compare'
import { useCrumbs } from '../lib/crumbs'
import { FAILURE_LABELS, ms, pct, when } from '../lib/format'
import { useMotionOn } from '../lib/prefs'
import type { CaseMatrix, Lineage, ProjectHome, TrialRow } from '../lib/types'

const comparablePoints = (l: Lineage | undefined) => (l?.points ?? []).filter((p) => !p.off_topic && p.at && p.pass_rate !== null).sort((a, b) => new Date(a.at!).getTime() - new Date(b.at!).getTime())

export function ProjectPage() {
  const { id } = useParams()
  const q = useQuery({ queryKey: ['project-home', id], queryFn: () => api.get<ProjectHome>(`/api/projects/${id}/home`) })
  const nav = useNavigate()
  const gates = useGateThresholds()
  const name = q.data?.project.name ?? '...'
  useCrumbs([{ label: 'Home', to: '/' }, { label: name }], `project-${id}-${name}`)
  const [linKey, setLinKey] = useState<string | null>(null)
  const [metric, setMetric] = useState<Metric>('pass')
  const [filter, setFilter] = useState<JourneyFilter>('all')

  // Lineages that can carry a line (not made only of off-topic runs); default: the latest run's.
  const h = q.data
  const lineages = (h?.lineages ?? []).filter((l) => l.points.some((p) => !p.off_topic))
  const latestId = h?.latest_run?.id ?? null
  const lineage = lineages.find((l) => l.key === linKey) ?? lineages.find((l) => latestId !== null && l.run_ids.includes(latestId)) ?? lineages[0]
  const offTopic: Point[] = (h?.lineages ?? []).flatMap((l) => l.points.filter((p) => p.off_topic))
  const pts = comparablePoints(lineage)
  const lastRun = pts.at(-1)?.run_id ?? latestId
  const datasetId = h?.recent_runs.find((r) => r.id === lastRun)?.dataset_id ?? h?.latest_run?.dataset_id ?? null

  const matrixQ = useQuery({
    queryKey: ['matrix', datasetId, id],
    queryFn: () => api.get<CaseMatrix>(`/api/datasets/${datasetId}/matrix?project_id=${id}`),
    enabled: datasetId !== null && datasetId !== undefined,
  })
  const trialsQ = useQuery({
    queryKey: ['trials', lastRun],
    queryFn: () => api.get<TrialRow[]>(`/api/runs/${lastRun}/trials`),
    enabled: !!lastRun,
  })

  if (q.isLoading) return <PageSkeleton />
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const p = h!.project
  const latest = h!.latest_run
  const gate = gates[p.id] ?? null
  const matrix = matrixQ.data
  const journeyRuns = matrix && lineage ? matrix.runs.map((r) => r.id).filter((r) => lineage.run_ids.includes(r)).sort((a, b) => a - b) : []
  const trialFor: Record<string, number> = {}
  for (const t of trialsQ.data ?? []) if (t.status !== 'passed' && trialFor[t.case_id] === undefined) trialFor[t.case_id] = t.id
  for (const t of trialsQ.data ?? []) trialFor[t.case_id] ??= t.id
  const counts = matrix && journeyRuns.length ? journeyCounts(matrix, journeyRuns) : null
  const lastPt = pts.at(-1)

  return (
    <>
      <PageHeader
        eyebrow="Chatbot"
        title={<span className="inline-flex items-center gap-3"><ProjectMark name={p.name} color={p.color} size={34} />{p.name}</span>}
        help={<>
          {p.description && <p>{p.description}</p>}
          <p>Everything below follows this chatbot’s comparable runs: the same questions, checks and judge, so the figures can be set side by side. A run that asked another chatbot’s questions is shown but kept out of the line.</p>
          <p>The needle is the latest pass rate; the black tick is the release gate.</p>
        </>}
        actions={latest && <div data-tour="verdict"><Needle mode="level" value={lastPt?.pass_rate ?? latest.metrics.overall_pass_rate} gate={gate} size={200} label={`latest pass rate ${pct(lastPt?.pass_rate ?? latest.metrics.overall_pass_rate)}`} /></div>}
      >
        {latest && <Verdict pts={pts} gate={gate} />}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Link to={`/runs/new?project=${p.id}`} viewTransition className={linkButton('primary', 'sm')}><Play className="size-3.5" />New run</Link>
          {h!.verdict && <Link to={`/compare?baseline=${h!.verdict.baseline_run_id}&candidate=${h!.verdict.candidate_run_id}`} viewTransition className={linkButton('secondary', 'sm')}><GitCompareArrows className="size-3.5" />Compare latest</Link>}
          <ColorPicker projectId={p.id} current={p.color} />
        </div>
      </PageHeader>

      {!latest ? (
        <Empty title="No completed run yet" action={<Link to={`/runs/new?project=${p.id}`} className={linkButton('primary')}>Start the first run</Link>}>
          Run a target of this chatbot on a dataset. Once two comparable runs exist, this page says whether it got better.
        </Empty>
      ) : (
        <div className="space-y-12">
          {lineage && (
            <Card title="Run timeline" meta={<SampleSize n={pts.length} min={3} unit={pts.length === 1 ? 'run' : 'runs'} />}
              help={<>
                <p>Pass rate of each comparable run, by date; the shaded band is its 95% interval. Notes above the line mark what changed in the variant (red where the pass rate fell). A hollow ring is a run left out of the line because it asked another chatbot’s questions.</p>
                <p>Click a run to see it on the right; <b>[</b> and <b>]</b> step through runs. Drag across the strip under the chart to read a range of runs.</p>
                <p>Comparable here: {lineage.comparability.dataset} v{lineage.comparability.dataset_version}, {lineage.comparability.n_cases} questions{lineage.comparability.case_filter ? ' (reduced suite)' : ''}, judge {lineage.comparability.judge ?? 'none'}, {lineage.comparability.evaluators.length} checks.</p>
              </>}
              actions={<>
                {lineages.length > 1 && (
                  <Select aria-label="Which comparable runs" value={lineage.key} onChange={(e) => setLinKey(e.target.value)}>
                    {lineages.map((l) => <option key={l.key} value={l.key}>runs #{Math.min(...l.run_ids)}–#{Math.max(...l.run_ids)} · {l.comparability.n_cases} questions · {l.comparability.judge ?? 'no judge'}</option>)}
                  </Select>
                )}
                <MetricSwitch value={metric} onChange={setMetric} />
              </>}>
              <RunTimeline key={lineage.key} lineage={lineage} offTopic={offTopic} gate={gate} matrix={matrix} defaultRun={lastRun} metric={metric} />
            </Card>
          )}

          {matrix && journeyRuns.length > 0 && counts && (
            <Card title="Case journey" meta={<SampleSize n={counts.all} unit="questions" />}
              help={<>
                <p>Every question across every comparable run, one dot per run: green passed every try, amber flaky, red failed every try. A coloured link means the result changed there: green better, red worse.</p>
                <p>The filters keep questions that flipped between the first and last run, always fail, or are flaky now. Failing questions come first. Hover a row to light that question everywhere; click it to open its answer in run #{lastRun}.</p>
              </>}
              actions={<Segmented size="sm" value={filter} onChange={setFilter} label="Which questions" options={[
                { id: 'all', label: <>All <span className="font-mono">{counts.all}</span></> },
                { id: 'flip', label: <>Flipped <span className="font-mono">{counts.flip}</span></> },
                { id: 'fail', label: <>Always fail <span className="font-mono">{counts.fail}</span></> },
                { id: 'flaky', label: <>Flaky now <span className="font-mono">{counts.flaky}</span></> },
              ]} />}>
              <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,1fr)_280px]">
                <CaseJourney matrix={matrix} runIds={journeyRuns} filter={filter} trialFor={trialFor} latestRun={lastRun ?? latest.id} />
                {journeyRuns.length > 1
                  ? <SlopeChart matrix={matrix} first={journeyRuns[0]} last={journeyRuns[journeyRuns.length - 1]} />
                  : <p className="text-sm text-ink-3">One run so far: the per-question slope needs a second one.</p>}
              </div>
            </Card>
          )}

          <LatestVsPrevious h={h!} />

          <div className="grid gap-10 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Card title={<>Where failures start · run <Link className="font-mono text-accent-ink hover:underline" to={`/runs/${latest.id}`}>#{latest.id}</Link></>}
              help={<>
                <p>The <Term k="stage">pipeline stages</Term> of the latest run, and how many failures start in each.</p>
                <p>Each failed trial is counted once per kind of failure it shows. The stage is where that kind of failure starts. Click a kind to see those answers.</p>
              </>}>
              <StagePipeline stages={h!.stages} onPick={undefined} />
              {h!.top_failures.length > 0 && <TopFailures h={h!} runId={latest.id} />}
            </Card>
            <div className="space-y-10">
              {latest.failed_trials ? <FixFirst runId={latest.id} targetId={latest.target_id} compact onPick={(c) => nav(`/runs/${latest.id}?tab=failures&cause=${c ?? ''}`)} /> : null}
              <NotesCard projectId={p.id} />
            </div>
          </div>

          <div className="grid gap-10 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Card title="Recent runs" padded={false} actions={<Link to="/runs" className="text-xs text-accent-ink hover:underline">All runs</Link>}>
              <div className="pt-2"><RunsTable runs={h!.recent_runs.slice(0, 8)} compact /></div>
            </Card>
            <div className="space-y-10">
              <Card title="Connections" padded={false} help={<p>Where this chatbot runs, and the version of each connection. The dot is the last health check: green answered, red failed, grey not checked yet.</p>}>
                <ul className="divide-y divide-line">
                  {h!.targets.map((t) => (
                    <li key={t.id}>
                      <Link to={`/targets/${t.id}`} viewTransition className="flex items-center gap-3 py-2.5 hover:bg-surface-2">
                        <HealthDot check={t.last_check} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{t.name} <span className="font-mono font-normal text-ink-3">v{t.version}</span></span>
                          <span className="block truncate text-xs text-ink-3">{t.variant_label || t.adapter}</span>
                        </span>
                        {t.local_judges_only && <Badge tone="accent">local judges only</Badge>}
                        <Badge>{t.adapter}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card title="Datasets" padded={false}>
                <ul className="divide-y divide-line">
                  {h!.datasets.map((d) => (
                    <li key={d.id}><Link to={`/datasets/${d.id}`} viewTransition className="flex items-center justify-between py-2.5 text-sm hover:bg-surface-2"><span className="font-medium">{d.name}</span><span className="text-xs text-ink-3"><span className="font-mono">{d.cases}</span> questions · <span className="font-mono">{d.versions}</span> version{d.versions === 1 ? '' : 's'}</span></Link></li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** "From 45% to 73% in three weeks. One dip on 2 Oct: ..." */
function Verdict({ pts, gate }: { pts: Point[]; gate: number | null }) {
  const first = pts[0]
  const last = pts.at(-1)
  if (!first || !last) return null
  const n = (v: number | null) => <span className="font-mono">{pct(v, 0)}</span>
  const lastGood = gate !== null ? (last.pass_rate ?? 0) >= gate : (last.pass_rate ?? 0) > (first.pass_rate ?? 0)
  if (pts.length === 1) {
    return <p className="t-verdict mt-2.5 max-w-[780px] text-ink-2" data-testid="project-verdict">First reading: {n(first.pass_rate)} on {dayLabel(first.at)}. <span className="text-ink-3">The next run draws the line.</span></p>
  }
  let dip: { p: Point; prev: Point; d: number } | null = null
  for (let i = 1; i < pts.length; i++) {
    const d = (pts[i].pass_rate ?? 0) - (pts[i - 1].pass_rate ?? 0)
    if (d < -0.02 && (!dip || d < dip.d)) dip = { p: pts[i], prev: pts[i - 1], d }
  }
  const up = (last.pass_rate ?? 0) >= (first.pass_rate ?? 0)
  const what = dip ? variantChange(dip.prev.variant, dip.p.variant) : null
  return (
    <p className="t-verdict mt-2.5 max-w-[820px] text-ink-2" data-testid="project-verdict">
      From {n(first.pass_rate)} {up ? 'to' : 'down to'} <span className={clsx('font-mono', lastGood ? 'text-good-ink' : up ? 'text-ink' : 'text-bad-ink')}>{pct(last.pass_rate, 0)}</span> {spanWords(first.at, last.at)}.{' '}
      {dip && <span className="text-ink-3">The largest dip was on {dayLabel(dip.p.at)}: down <span className="font-mono">{Math.abs(dip.d * 100).toFixed(0)}pp</span> at run <span className="font-mono">#{dip.p.run_id}</span>{what ? <>, after “{what}”</> : null}.</span>}
    </p>
  )
}

function LatestVsPrevious({ h }: { h: ProjectHome }) {
  const v = h.verdict
  if (!v) return null
  const s = verdictSentence(v)
  return (
    <Card title={<>Latest against previous · <span className="font-mono">#{v.baseline_run_id} → #{v.candidate_run_id}</span></>}
      meta={<SampleSize n={v.n_shared_cases} unit="shared" />}
      help={<>
        <p>The latest run against the previous comparable one, metric by metric, on the questions both asked.</p>
        <p>Each change carries its 95% interval. If the interval covers zero, the difference could be chance.</p>
      </>}
      actions={<Link to={`/compare?baseline=${v.baseline_run_id}&candidate=${v.candidate_run_id}`} viewTransition className="inline-flex items-center gap-1 text-sm font-medium text-accent-ink hover:underline">Every metric, every case <ArrowRight className="size-3.5" /></Link>}>
      <p className={clsx('t-readout', s.tone === 'good' && 'text-good-ink', s.tone === 'bad' && 'text-bad-ink')}>{s.text}</p>
      <div className="mt-4"><DeltaList rows={v.rows} /></div>
    </Card>
  )
}

function TopFailures({ h, runId }: { h: ProjectHome; runId: number }) {
  const motionOn = useMotionOn()
  const max = h.top_failures[0].count
  return (
    <ul className="mt-4 space-y-1.5">
      {h.top_failures.map((f) => (
        <li key={f.type}>
          <Link to={`/runs/${runId}?tab=failures&failure=${f.type}`} viewTransition className="group grid grid-cols-[170px_minmax(0,1fr)_32px] items-center gap-2 text-sm">
            <span className="truncate group-hover:underline">{FAILURE_LABELS[f.type] ?? f.type}</span>
            <span className="h-2 rounded-full bg-surface-2"><motion.span className="block h-full rounded-full bg-bad/70" initial={motionOn ? { width: 0 } : false} animate={{ width: `${(f.count / max) * 100}%` }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} /></span>
            <span className="text-right font-mono text-xs text-ink-2">{f.count}</span>
          </Link>
        </li>
      ))}
    </ul>
  )
}

export function HealthDot({ check }: { check: ProjectHome['targets'][number]['last_check'] }) {
  const tone = !check ? 'bg-untested' : check.ok ? 'bg-good' : 'bg-bad'
  const title = !check ? 'Not checked yet' : check.ok ? `Answered ${check.elapsed_ms ? ms(check.elapsed_ms) : ''} - ${when(check.at)}` : `${check.explanation ?? check.error ?? 'Failed'} - ${when(check.at)}`
  return <span className={clsx('size-2.5 shrink-0 rounded-full', tone)} title={title} aria-label={title} />
}

function ColorPicker({ projectId, current }: { projectId: number; current: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const save = useMutation({
    mutationFn: (color: string) => api.patch(`/api/projects/${projectId}`, { color }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['project-home'] }); qc.invalidateQueries({ queryKey: ['projects'] }); qc.invalidateQueries({ queryKey: ['home'] }); setOpen(false) },
    meta: { silent: true },
  })
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className={linkButton('ghost', 'sm')} aria-label="Chatbot colour"><Palette className="size-3.5" /></button>
      {open && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="absolute left-0 z-20 mt-1 flex gap-1.5 rounded-lg border border-line bg-surface p-2 shadow-pop">
          {Object.entries(PROJECT_COLORS).map(([k, c]) => (
            <button key={k} type="button" title={k} disabled={save.isPending} onClick={() => save.mutate(k)} className={clsx('size-6 rounded-md ring-offset-2 ring-offset-surface', current === k && 'ring-2 ring-accent')} style={{ background: c }} />
          ))}
          {save.isError && <span role="alert" className="ml-1 self-center text-xs text-bad-ink">{save.error.message}</span>}
        </motion.div>
      )}
    </div>
  )
}
