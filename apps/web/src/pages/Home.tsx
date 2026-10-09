import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowRight, Lightbulb, Sparkles } from 'lucide-react'
import { motion } from 'motion/react'
import { useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { ActivityStream, regressionItem, WorthALook, type LookItem } from '../components/home/Activity'
import { ConnectCard, ReadingCard } from '../components/home/ReadingCard'
import { STAGGER, useGateThresholds } from '../components/home/shared'
import { Badge, Button, Card, Code, ErrorState, Notice, PageHeader, PageSkeleton, Panel, ProgressBar, StatusBadge, linkButton } from '../components/ui'
import { api } from '../lib/api'
import { useCrumbs } from '../lib/crumbs'
import { fmtDay } from '../lib/format'
import { useMotionOn } from '../lib/prefs'
import type { CalibrationStats, Comparison, HomeData, RunHeader, TrialRow } from '../lib/types'

export function HomePage() {
  useCrumbs([{ label: 'Home' }], 'home')
  const ctx = useOutletContext<{ startTour?: () => void } | undefined>()
  const q = useQuery({
    queryKey: ['home'],
    queryFn: () => api.get<HomeData>('/api/home'),
    refetchInterval: (query) => (query.state.data?.active_runs.length ? 2000 : false),
  })
  const live = !!q.data?.active_runs.length
  const runsQ = useQuery({
    queryKey: ['runs', 'recent', 20],
    queryFn: () => api.get<RunHeader[]>('/api/runs?limit=20'),
    refetchInterval: live ? 4000 : false,
  })
  const calib = useQuery({ queryKey: ['calibration', 'correctness', 'stats'], queryFn: () => api.get<CalibrationStats>('/api/calibration/correctness/stats') })
  const gates = useGateThresholds()
  const [today] = useState(() => fmtDay(new Date().toISOString()))
  const shown = (q.data?.projects ?? []).filter((p) => !(q.data?.settings.hide_demo && p.is_demo))
  const pair = shown.find((p) => p.latest_run_id && p.previous_run_id)
  const cmp = useQuery({
    queryKey: ['compare', pair?.previous_run_id, pair?.latest_run_id],
    queryFn: () => api.get<Comparison>(`/api/runs/compare?baseline=${pair!.previous_run_id}&candidate=${pair!.latest_run_id}`),
    enabled: !!pair,
  })
  const trials = useQuery({
    queryKey: ['trials', pair?.latest_run_id],
    queryFn: () => api.get<TrialRow[]>(`/api/runs/${pair!.latest_run_id}/trials`),
    enabled: !!pair,
  })

  if (q.isLoading) return <PageSkeleton />
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const h = q.data!
  const noJudge = !h.settings.default_judge
  const runs = runsQ.data ?? []
  const byId: Record<number, RunHeader> = Object.fromEntries(runs.map((r) => [r.id, r]))
  const projectName = (id: number | null | undefined) => h.projects.find((p) => p.id === id)?.name ?? ''

  // The trial to open for a question: its first failed try in the latest run, else its first try.
  const trialFor: Record<string, number> = {}
  for (const t of trials.data ?? []) if (t.status !== 'passed' && trialFor[t.case_id] === undefined) trialFor[t.case_id] = t.id
  for (const t of trials.data ?? []) trialFor[t.case_id] ??= t.id

  const look: LookItem[] = []
  if (pair && cmp.data) {
    for (const r of cmp.data.regressions.slice(0, 4)) look.push(regressionItem(r, pair.previous_run_id!, (c) => trialFor[c], pair.latest_run_id!))
    const flaky = cmp.data.candidate_summary.reliability.flaky_cases ?? []
    if (flaky.length) {
      look.push({
        key: 'flaky', dot: 'bg-flaky', to: `/p/${pair.id}`,
        title: <><span className="font-mono">{flaky.length}</span> question{flaky.length === 1 ? ' is' : 's are'} flaky</>,
        body: <>they pass some tries and fail others in run <span className="font-mono">#{pair.latest_run_id}</span>: the answer depends on luck</>,
        chip: <Badge tone="flaky">Flaky</Badge>,
      })
    }
  }
  const c = calib.data
  if (c && (c.status === 'Uncalibrated' || c.agreement.n === 0)) {
    look.push({
      key: 'calib', dot: 'bg-series-1', to: '/calibration',
      title: 'The grading model is unchecked',
      body: <>label <span className="font-mono">20</span> answers to see how often the grading model agrees with you</>,
      chip: <Badge tone="neutral">Calibrate</Badge>,
    })
  }
  for (const r of runs.filter((x) => x.off_topic).slice(0, 2)) {
    look.push({
      key: `off-${r.id}`, dot: 'bg-warn', to: `/runs/${r.id}`,
      title: <>Run <span className="font-mono">#{r.id}</span> asked another chatbot’s questions</>,
      body: <>they were written for {r.off_topic}, so the run is left out of {projectName(r.project_id) || 'its chatbot'}’s trend</>,
      chip: <Badge tone="unmeasured">Left out</Badge>,
    })
  }

  return (
    <>
      <PageHeader
        eyebrow={today}
        title={<>Your chatbots, <em>today’s reading.</em></>}
        help={<>
          <p>Each chatbot’s latest run against its last comparable one: the same questions, checks and grading model.</p>
          <p>The needle is the pass rate; the black tick on the arc is the release gate. The dots are the run’s fingerprint, one per question: green passed every try, amber flaky, red failed every try.</p>
          <p>Open a chatbot for its history.</p>
        </>}
        actions={<Button onClick={() => ctx?.startTour?.()}><Lightbulb className="size-3.5" /> Take the tour</Button>}
      />

      <div className="space-y-12">
        {(h.projects.length > 0 || h.active_runs.length > 0) && (
          <div className="space-y-3">
            {h.projects.length > 0 && <StatusRow noJudge={noJudge} hasProviders={h.has_providers} passing={shown.filter((p) => p.gate_status === 'PASS').length} gated={shown.filter((p) => p.gate_status).length} />}
            {h.active_runs.map((r) => (
              <Link key={r.id} to={`/runs/${r.id}`} viewTransition className="block rounded-xl border border-accent/30 bg-accent-wash/50 px-4 py-3 transition-colors duration-(--dur-fast) hover:border-accent/60">
                <div className="mb-1.5 flex items-center gap-2 text-sm"><StatusBadge status={r.status} /><span className="font-medium"><span className="font-mono">#{r.id}</span> {r.experiment}</span><span className="ml-auto font-mono text-xs text-ink-3">{r.progress_done}/{r.progress_total}</span></div>
                <ProgressBar value={r.progress_total ? r.progress_done / r.progress_total : 0} />
              </Link>
            ))}
          </div>
        )}

        {h.projects.length === 0 ? <FirstSteps /> : (
          <>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] gap-6" data-tour="projects">
              {shown.map((p, i) => <ReadingCard key={p.id} p={p} i={i} gate={gates[p.id] ?? null} runs={byId} />)}
              <ConnectCard i={shown.length} />
            </div>

            <div className="grid gap-x-10 gap-y-12 lg:grid-cols-[7fr_5fr]">
              <Card title="Recent activity" help={<p>Runs, release gate results and anything left out of trends, newest first. Click a line to open that run.</p>}>
                <ActivityStream runs={runs} projectName={projectName} gates={gates} multi={h.projects.length > 1} />
              </Card>
              <Card title="Worth a look" help={<>
                <p>From the latest comparable pair{pair ? <> (<span className="font-mono">#{pair.previous_run_id}</span> → <span className="font-mono">#{pair.latest_run_id}</span>, {pair.name})</> : null}: questions that regressed, and questions that are flaky.</p>
                <p>Also anything not yet checked: a grading model nobody has compared with their own labels, and runs that asked another chatbot’s questions.</p>
              </>}>
                <WorthALook items={look} />
              </Card>
            </div>
          </>
        )}
      </div>
    </>
  )
}

function StatusRow({ noJudge, hasProviders, passing, gated }: { noJudge: boolean; hasProviders: boolean; passing: number; gated: number }) {
  return (
    <div data-testid="status-row" className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-line bg-surface/60 px-3 py-2 text-sm text-ink-2">
      <span className={clsx('size-2 shrink-0 rounded-full', noJudge ? 'bg-warn' : 'bg-good')} />
      {noJudge ? (
        <span className="min-w-0 flex-1"><span className="font-semibold text-ink">No default grading model.</span> Objective checks still run; meaning-based checks (correctness, groundedness) need one{hasProviders ? '' : ': local Ollama or your own key'}.</span>
      ) : (
        <span className="min-w-0 flex-1">
          <span className="font-semibold text-ink">Ready.</span> A default grading model is set{gated ? <>; <span className="font-mono">{passing}</span> of <span className="font-mono">{gated}</span> gated chatbot{gated === 1 ? '' : 's'} pass their release gate</> : ''}.
        </span>
      )}
      <Link to="/settings?tab=models" className={linkButton(noJudge ? 'secondary' : 'ghost', 'sm')}><Sparkles className="size-3.5" />Models & keys</Link>
    </div>
  )
}

function FirstSteps() {
  const motionOn = useMotionOn()
  const steps = [
    { n: 1, title: 'Connect a chatbot', body: 'Paste a curl command or pick a template. Bots that reply in the Assay shape need no mapping.', to: '/targets/new', cta: 'Connect' },
    { n: 2, title: 'Add a dataset', body: 'Import a YAML or CSV file, or draft questions from your documents and approve them.', to: '/datasets', cta: 'Datasets' },
    { n: 3, title: 'Run and compare', body: 'Run two versions on the same questions and see what changed, with the uncertainty stated.', to: '/runs/new', cta: 'New run' },
  ]
  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-3">
        {steps.map((s, i) => (
          <motion.div key={s.n} initial={motionOn ? { opacity: 0, y: 10 } : false} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * STAGGER }}>
            <Panel className="h-full">
            <span className="flex size-8 items-center justify-center rounded-full bg-accent font-mono text-base font-semibold text-on-accent">{s.n}</span>
            <h2 className="mt-3 text-h font-semibold">{s.title}</h2>
            <p className="mt-1 text-sm text-ink-2">{s.body}</p>
            <Link to={s.to} className={clsx(linkButton(i === 0 ? 'primary' : 'secondary'), 'mt-4')}>{s.cta} <ArrowRight className="size-3.5" /></Link>
            </Panel>
          </motion.div>
        ))}
      </div>
      <Notice title="Want to see it working first?">Load the fictional Acme demo (a support chatbot in two versions, 58 questions, a release gate): run <Code>assay seed --run</Code>, then reload.</Notice>
    </div>
  )
}
