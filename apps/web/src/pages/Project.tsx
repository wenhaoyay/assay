import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowRight, GitCompareArrows, Palette, Play } from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { RunsTable } from '../components/RunsTable'
import { DeltaList, StagePipeline, VerdictNeedle } from '../components/viz'
import { Badge, Card, Empty, ErrorState, Explain, PageHeader, PageSkeleton, PROJECT_COLORS, ProjectMark, Segmented, Term, linkButton } from '../components/ui'
import { api } from '../lib/api'
import { verdictSentence } from '../lib/compare'
import { useCrumbs } from '../lib/crumbs'
import { FAILURE_LABELS, ms, pct, when } from '../lib/format'
import type { Lineage, ProjectHome } from '../lib/types'

export function ProjectPage() {
  const { id } = useParams()
  const q = useQuery({ queryKey: ['project-home', id], queryFn: () => api.get<ProjectHome>(`/api/projects/${id}/home`) })
  const name = q.data?.project.name ?? '...'
  useCrumbs([{ label: 'Home', to: '/' }, { label: name }], `project-${id}-${name}`)
  if (q.isLoading) return <PageSkeleton />
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const h = q.data!
  const p = h.project
  const latest = h.latest_run

  return (
    <>
      <PageHeader
        title={<span className="flex items-center gap-3"><ProjectMark name={p.name} color={p.color} size={34} />{p.name}</span>}
        description={p.description}
        actions={
          <>
            <ColorPicker projectId={p.id} current={p.color} />
            {h.verdict && <Link to={`/compare?baseline=${h.verdict.baseline_run_id}&candidate=${h.verdict.candidate_run_id}`} viewTransition className={linkButton()}><GitCompareArrows className="size-3.5" />Compare latest</Link>}
            <Link to={`/runs/new?project=${p.id}`} viewTransition className={linkButton('primary')}><Play className="size-3.5" />New run</Link>
          </>
        }
      />
      {!latest ? (
        <Empty title="No completed run yet" action={<Link to={`/runs/new?project=${p.id}`} className={linkButton('primary')}>Start the first run</Link>}>
          Run a target of this chatbot on a dataset. Once two comparable runs exist, this page says whether it got better.
        </Empty>
      ) : (
        <div className="space-y-5">
          <VerdictCard h={h} />
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <TrendCard lineages={h.lineages} />
            <Card title={<>Where failures start - run <Link className="font-mono text-accent-ink hover:underline" to={`/runs/${latest.id}`}>#{latest.id}</Link></>}
              subtitle={<Term k="stage">Pipeline stages</Term>}>
              <StagePipeline stages={h.stages} onPick={undefined} />
              {h.top_failures.length > 0 && (
                <ul className="mt-4 space-y-1.5">
                  {h.top_failures.map((f) => {
                    const max = h.top_failures[0].count
                    return (
                      <li key={f.type}>
                        <Link to={`/runs/${latest.id}?tab=failures&failure=${f.type}`} viewTransition className="group grid grid-cols-[150px_minmax(0,1fr)_32px] items-center gap-2 text-[13px]">
                          <span className="truncate group-hover:underline">{FAILURE_LABELS[f.type] ?? f.type}</span>
                          <span className="h-2 rounded-full bg-surface-2"><motion.span className="block h-full rounded-full bg-bad/70" initial={{ width: 0 }} animate={{ width: `${(f.count / max) * 100}%` }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} /></span>
                          <span className="num text-right text-xs text-ink-2">{f.count}</span>
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              )}
              <Explain className="mt-3">Each failed trial is counted once per kind of failure it shows. The stage is where that kind of failure starts.</Explain>
            </Card>
          </div>
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
            <Card title="Recent runs" padded={false} actions={<Link to="/runs" className="text-xs text-accent-ink hover:underline">All runs</Link>}>
              <RunsTable runs={h.recent_runs.slice(0, 8)} compact />
            </Card>
            <div className="space-y-5">
              <Card title="Targets (versions of this chatbot)" padded={false}>
                <ul className="divide-y divide-line">
                  {h.targets.map((t) => (
                    <li key={t.id}>
                      <Link to={`/targets/${t.id}`} viewTransition className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-2">
                        <HealthDot check={t.last_check} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium">{t.name} <span className="font-normal text-ink-3">v{t.version}</span></span>
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
                  {h.datasets.map((d) => (
                    <li key={d.id}><Link to={`/datasets/${d.id}`} viewTransition className="flex items-center justify-between px-4 py-2.5 text-[13px] hover:bg-surface-2"><span className="font-medium">{d.name}</span><span className="num text-xs text-ink-3">{d.cases} cases - {d.versions} version(s)</span></Link></li>
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

export function HealthDot({ check }: { check: ProjectHome['targets'][number]['last_check'] }) {
  const tone = !check ? 'bg-untested' : check.ok ? 'bg-good' : 'bg-bad'
  const title = !check ? 'Not checked yet' : check.ok ? `Answered ${check.elapsed_ms ? ms(check.elapsed_ms) : ''} - ${when(check.at)}` : `${check.explanation ?? check.error ?? 'Failed'} - ${when(check.at)}`
  return <span className={clsx('size-2.5 shrink-0 rounded-full', tone)} title={title} aria-label={title} />
}

function VerdictCard({ h }: { h: ProjectHome }) {
  const v = h.verdict
  if (!v) {
    return (
      <Card title="Verdict">
        <p className="text-[13px] text-ink-2">Only one comparable run so far (#{h.latest_run?.id}). Run another version on the same questions, checks and judge to see whether it got better.</p>
      </Card>
    )
  }
  const s = verdictSentence(v)
  const o = v.overall
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-card" data-tour="verdict">
      <div className="grid items-center gap-5 p-5 md:grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex flex-col items-center">
          <VerdictNeedle delta={o?.delta ?? null} low={o?.ci?.ci_low} high={o?.ci?.ci_high} label={s.text} />
          <span className="num -mt-1 text-xs text-ink-3">pass rate {pct(o?.baseline)} → <b className="text-ink">{pct(o?.candidate)}</b></span>
        </div>
        <div className="min-w-0">
          <div className="text-xs font-medium text-ink-3">Latest run <Link className="font-mono text-accent-ink hover:underline" to={`/runs/${v.candidate_run_id}`}>#{v.candidate_run_id}</Link> vs the previous comparable run <Link className="font-mono text-accent-ink hover:underline" to={`/runs/${v.baseline_run_id}`}>#{v.baseline_run_id}</Link>, {v.n_shared_cases} shared cases</div>
          <p className={clsx('mt-1 text-[17px] font-semibold leading-snug', s.tone === 'good' && 'text-good-ink', s.tone === 'bad' && 'text-bad-ink')}>{s.text}</p>
          <Explain className="mt-1">The grey arc on the gauge is the 95% interval of the change. If it covers the middle (no change), the difference could be chance.</Explain>
          <div className="mt-4"><DeltaList rows={v.rows} /></div>
          <Link to={`/compare?baseline=${v.baseline_run_id}&candidate=${v.candidate_run_id}`} viewTransition className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-accent-ink hover:underline">
            Every metric, every case <ArrowRight className="size-3.5" />
          </Link>
        </div>
      </div>
    </section>
  )
}

function TrendCard({ lineages }: { lineages: Lineage[] }) {
  const [sel, setSel] = useState(0)
  const [metric, setMetric] = useState<'pass_rate' | 'p95_latency_ms'>('pass_rate')
  const nav = useNavigate()
  const lin = lineages[Math.min(sel, lineages.length - 1)]
  if (!lin) return null
  const c = lin.comparability
  return (
    <Card title="Trend" subtitle={<>Only <Term k="comparable">comparable runs</Term> are drawn on one line.</>}
      actions={<Segmented size="sm" value={metric} onChange={setMetric} options={[{ id: 'pass_rate', label: 'Pass rate' }, { id: 'p95_latency_ms', label: 'p95 latency' }]} />}>
      {lineages.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {lineages.map((l, i) => (
            <button key={l.key} type="button" onClick={() => setSel(i)}
              className={clsx('rounded-lg border px-2.5 py-1 text-left text-xs', i === sel ? 'border-accent bg-accent-wash text-accent-ink' : 'border-line text-ink-2 hover:bg-surface-2')}>
              runs #{Math.min(...l.run_ids)}-#{Math.max(...l.run_ids)} - {l.comparability.n_cases} cases - {l.comparability.evaluators.length} checks - {l.comparability.judge ?? 'no judge'}
            </button>
          ))}
        </div>
      )}
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={lin.points} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}
          onClick={(e) => { const r = (e as { activePayload?: { payload: { run_id: number } }[] } | null)?.activePayload?.[0]?.payload?.run_id; if (r) nav(`/runs/${r}`) }}>
          <CartesianGrid vertical={false} stroke="var(--line)" />
          <XAxis dataKey="run_id" tickFormatter={(v) => `#${v}`} stroke="var(--line-strong)" tick={{ fill: 'var(--ink-3)', fontSize: 11 }} tickLine={false} />
          <YAxis stroke="var(--line-strong)" tick={{ fill: 'var(--ink-3)', fontSize: 11 }} axisLine={false} tickLine={false}
            domain={metric === 'pass_rate' ? [0, 1] : ['auto', 'auto']} tickFormatter={(v: number) => (metric === 'pass_rate' ? `${Math.round(v * 100)}%` : ms(v))} />
          <Tooltip cursor={{ stroke: 'var(--line-strong)' }} content={({ active, payload }) => {
            if (!active || !payload?.length) return null
            const pt = payload[0].payload as Lineage['points'][number]
            return (
              <div className="rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-sm">
                <div className="font-medium">Run #{pt.run_id}</div>
                <div className="text-ink-3">{pt.target} - {pt.variant}</div>
                <div className="num mt-1">pass rate <b>{pct(pt.pass_rate)}</b> - p95 <b>{ms(pt.p95_latency_ms)}</b></div>
              </div>
            )
          }} />
          <Line type="monotone" dataKey={metric} stroke="var(--accent)" strokeWidth={2} dot={{ r: 3.5, fill: 'var(--accent)', stroke: 'var(--surface)', strokeWidth: 1.5 }} activeDot={{ r: 5 }} isAnimationActive />
        </LineChart>
      </ResponsiveContainer>
      <p className="mt-2 text-xs text-ink-3">{c.dataset} v{c.dataset_version} - {c.n_cases} cases{c.case_filter ? ' (reduced suite)' : ''} - judge {c.judge ?? 'none'} - {c.evaluators.length} checks. Click a point to open that run.</p>
    </Card>
  )
}

function ColorPicker({ projectId, current }: { projectId: number; current: string }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const save = useMutation({
    mutationFn: (color: string) => api.patch(`/api/projects/${projectId}`, { color }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['project-home'] }); qc.invalidateQueries({ queryKey: ['projects'] }); qc.invalidateQueries({ queryKey: ['home'] }); setOpen(false) },
  })
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className={linkButton('ghost')} aria-label="Chatbot colour"><Palette className="size-3.5" /></button>
      {open && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="absolute right-0 z-20 mt-1 flex gap-1.5 rounded-lg border border-line bg-surface p-2 shadow-pop">
          {Object.entries(PROJECT_COLORS).map(([k, c]) => (
            <button key={k} type="button" title={k} onClick={() => save.mutate(k)} className={clsx('size-6 rounded-md ring-offset-2 ring-offset-surface', current === k && 'ring-2 ring-accent')} style={{ background: c }} />
          ))}
        </motion.div>
      )}
    </div>
  )
}
