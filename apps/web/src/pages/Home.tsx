import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { ArrowDownRight, ArrowRight, ArrowUpRight, Database, GitCompareArrows, Lightbulb, Play, Plug, Scale, Sparkles } from 'lucide-react'
import { motion } from 'motion/react'
import { Link, useOutletContext } from 'react-router-dom'
import { Sparkline } from '../components/viz'
import { Badge, Button, Code, ErrorState, Explain, Notice, PageHeader, PageSkeleton, ProgressBar, ProjectMark, StatusBadge, Term, linkButton } from '../components/ui'
import { api } from '../lib/api'
import { useCrumbs } from '../lib/crumbs'
import { pct, when } from '../lib/format'
import type { HomeData, ProjectCard } from '../lib/types'

export function HomePage() {
  useCrumbs([{ label: 'Home' }], 'home')
  const ctx = useOutletContext<{ startTour?: () => void } | undefined>()
  const q = useQuery({
    queryKey: ['home'],
    queryFn: () => api.get<HomeData>('/api/home'),
    refetchInterval: (query) => (query.state.data?.active_runs.length ? 2000 : false),
  })
  if (q.isLoading) return <PageSkeleton />
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const h = q.data!
  const noJudge = !h.settings.default_judge

  return (
    <>
      <PageHeader
        title="Your chatbots"
        description="How each chatbot is doing, from its latest run against its last comparable one. Open one for the details."
        actions={<Button onClick={() => ctx?.startTour?.()}><Lightbulb className="size-3.5" /> Take the tour</Button>}
      />

      {h.active_runs.length > 0 && (
        <div className="mb-5 space-y-2">
          {h.active_runs.map((r) => (
            <Link key={r.id} to={`/runs/${r.id}`} viewTransition className="block rounded-xl border border-accent/30 bg-accent-wash/50 px-4 py-3 hover:border-accent/60">
              <div className="mb-1.5 flex items-center gap-2 text-sm"><StatusBadge status={r.status} /><span className="font-medium">#{r.id} {r.experiment}</span><span className="num ml-auto text-xs text-ink-3">{r.progress_done}/{r.progress_total} trials</span></div>
              <ProgressBar value={r.progress_total ? r.progress_done / r.progress_total : 0} />
            </Link>
          ))}
        </div>
      )}

      {h.projects.length === 0 ? <FirstSteps /> : (
        <>
          {noJudge && (
            <div className="mb-5">
              <Notice title="Pick a default grading model" action={<Link to="/settings?tab=models" className={linkButton('secondary', 'sm')}><Sparkles className="size-3.5" />Models & keys</Link>}>
                Objective checks run without one. Meaning-based checks (correctness, groundedness...) need an LLM judge: local Ollama, or your own OpenAI key.
              </Notice>
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-tour="projects">
            {h.projects.filter((p) => !(h.settings.hide_demo && p.is_demo)).map((p, i) => <ProjectTile key={p.id} p={p} i={i} />)}
            <Link to="/targets/new" viewTransition
              className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong text-sm text-ink-3 transition-colors hover:border-accent hover:text-accent-ink">
              <Plug className="size-5" />Connect another chatbot
            </Link>
          </div>
          <QuickActions />
        </>
      )}
    </>
  )
}

function ProjectTile({ p, i }: { p: ProjectCard; i: number }) {
  const change = p.latest_pass_rate !== null && p.previous_pass_rate !== null ? p.latest_pass_rate - p.previous_pass_rate : null
  const Arrow = change === null ? null : change > 0 ? ArrowUpRight : change < 0 ? ArrowDownRight : null
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, type: 'spring', stiffness: 260, damping: 26 }}>
      <Link to={`/p/${p.id}`} viewTransition className="group block h-full rounded-xl border border-line bg-surface p-4 shadow-card transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-line-strong hover:shadow-pop">
        <div className="flex items-start gap-3">
          <ProjectMark name={p.name} color={p.color} size={36} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-h font-semibold">{p.name}</h2>
              {p.is_demo && <Badge title="Seeded sample data (Settings > Defaults can hide it)">Demo</Badge>}
              {p.active_runs > 0 && <Badge tone="info">running</Badge>}
            </div>
            <p className="line-clamp-2 text-xs text-ink-3">{p.description || `${p.counts.targets} connection(s), ${p.counts.datasets} dataset(s)`}</p>
          </div>
          <ArrowRight className="size-4 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
        {p.latest_run_id ? (
          <>
            <div className="mt-4 flex items-end justify-between gap-3">
              <div>
                <div className="text-xs text-ink-3"><Term k="pass_rate">Pass rate</Term>, run #{p.latest_run_id}</div>
                <div className="num text-fig-xl font-semibold leading-none tracking-tight">{pct(p.latest_pass_rate)}</div>
                {change !== null ? (
                  <div className={clsx('num mt-1 flex items-center gap-0.5 text-xs font-medium', change > 0 ? 'text-good-ink' : change < 0 ? 'text-bad-ink' : 'text-ink-3')}>
                    {Arrow && <Arrow className="size-3.5" />}{change > 0 ? '+' : ''}{(change * 100).toFixed(1)}pp <span className="font-normal text-ink-3">vs #{p.previous_run_id}</span>
                  </div>
                ) : <div className="mt-1 text-xs text-ink-3">no earlier comparable run</div>}
              </div>
              <Sparkline values={p.trend.map((t) => t.pass_rate)} width={130} height={44} label={`${p.name} pass-rate trend`} />
            </div>
            <div className="mt-3 flex items-center gap-2 border-t border-line pt-3 text-xs text-ink-3">
              {p.gate_status ? <StatusBadge status={p.gate_status} /> : <span>no gate applied</span>}
              <span className="ml-auto">{p.counts.runs} run(s) - {when(p.latest_at)}</span>
            </div>
            <Explain className="mt-2">The change compares runs on the same questions, checks and judge. Different setups are kept apart.</Explain>
          </>
        ) : (
          <div className="mt-4 rounded-lg bg-surface-2 p-3 text-xs text-ink-2">No completed run yet. <span className="font-medium text-accent-ink">Start one →</span></div>
        )}
      </Link>
    </motion.div>
  )
}

function QuickActions() {
  const items = [
    { to: '/runs/new', icon: Play, title: 'New run', body: 'Ask a chatbot version every question in a dataset.' },
    { to: '/compare', icon: GitCompareArrows, title: 'Compare', body: 'Did the new version get better, worse or just different?' },
    { to: '/calibration', icon: Scale, title: 'Label answers', body: 'Check the grading model against your own judgement.' },
    { to: '/datasets', icon: Database, title: 'Datasets', body: 'Golden questions with what a right answer contains.' },
  ]
  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {items.map(({ to, icon: Icon, title, body }) => (
        <Link key={to} to={to} viewTransition className="group flex gap-3 rounded-xl border border-line bg-surface p-3 transition-colors hover:border-accent/50">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-wash text-accent-ink transition-transform group-hover:scale-110"><Icon className="size-4" /></span>
          <span><span className="block text-sm font-medium">{title}</span><span className="block text-xs text-ink-3">{body}</span></span>
        </Link>
      ))}
    </div>
  )
}

function FirstSteps() {
  const steps = [
    { n: 1, title: 'Connect a chatbot', body: 'Paste a curl command or pick a template. Bots that reply in the GaugeLab shape need no mapping.', to: '/targets/new', cta: 'Connect' },
    { n: 2, title: 'Add golden questions', body: 'Import a YAML/CSV dataset, or draft cases from your documents and approve them.', to: '/datasets', cta: 'Datasets' },
    { n: 3, title: 'Run and compare', body: 'Run two versions on the same questions and see what changed, with the uncertainty stated.', to: '/runs/new', cta: 'New run' },
  ]
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-3">
        {steps.map((s, i) => (
          <motion.div key={s.n} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.08 }}
            className="rounded-xl border border-line bg-surface p-5 shadow-card">
            <span className="flex size-8 items-center justify-center rounded-full bg-accent text-base font-semibold text-on-accent">{s.n}</span>
            <h2 className="mt-3 text-h font-semibold">{s.title}</h2>
            <p className="mt-1 text-sm text-ink-2">{s.body}</p>
            <Link to={s.to} className={clsx(linkButton(i === 0 ? 'primary' : 'secondary'), 'mt-4')}>{s.cta} <ArrowRight className="size-3.5" /></Link>
          </motion.div>
        ))}
      </div>
      <Notice title="Want to see it working first?">Load the fictional Acme demo (a support agent in two variants, 58 golden cases, a release gate): run <Code>gaugelab seed --run</Code>, then reload.</Notice>
    </div>
  )
}
