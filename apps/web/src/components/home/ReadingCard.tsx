// Home: one "today's reading" card per chatbot, the first-reading variant, and the empty card.
import clsx from 'clsx'
import { Lightbulb } from 'lucide-react'
import { motion } from 'motion/react'
import { Link } from 'react-router-dom'
import { useMotionOn } from '../../lib/prefs'
import { ms, pct, usd } from '../../lib/format'
import type { ProjectCard, RunHeader } from '../../lib/types'
import { PpDelta } from '../compare/delta'
import { Fingerprint, Needle, Odometer } from '../instrument'
import { Badge, Empty, Panel, ProjectMark, linkButton } from '../ui'
import { Sparkline, Stamp } from '../viz'
import { dayLabel, STAGGER } from './shared'

export function ReadingCard({ p, i, gate, runs }: { p: ProjectCard; i: number; gate: number | null; runs: Record<number, RunHeader> }) {
  const motionOn = useMotionOn()
  const first = p.trend.length <= 1 || p.previous_run_id === null
  const latest = p.latest_run_id ? runs[p.latest_run_id] : undefined
  const firstRun = p.trend.length ? runs[p.trend[0].run_id] : undefined
  const good = gate !== null && p.latest_pass_rate !== null && p.latest_pass_rate >= gate
  const change = p.latest_pass_rate !== null && p.previous_pass_rate !== null ? p.latest_pass_rate - p.previous_pass_rate : null
  const missing = latest ? [latest.metrics.p95_latency_ms == null && 'Speed', latest.metrics.average_cost_usd == null && 'cost'].filter(Boolean) as string[] : []

  return (
    <motion.div className="min-w-0" initial={motionOn ? { opacity: 0, y: 10 } : false} animate={{ opacity: 1, y: 0 }}
      transition={{ delay: i * STAGGER, type: 'spring', stiffness: 260, damping: 26 }}>
      <Panel padded={false} className="h-full overflow-hidden transition-colors duration-(--dur-fast) hover:border-line-strong">
      <Link to={`/p/${p.id}`} viewTransition data-testid="reading-card"
        className="group flex h-full min-w-0 flex-col gap-3.5 p-[var(--card-p)]">
        <div className="flex items-start gap-3">
          <ProjectMark name={p.name} color={p.color} size={30} />
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <span className="min-w-0">{p.name}</span>
              {p.active_runs > 0 && <Badge tone="info">running</Badge>}
            </h2>
            {p.latest_variant && <div className="line-clamp-2 text-sm text-ink-2">{p.latest_variant}</div>}
          </div>
          {p.latest_run_id && (first
            ? <Badge tone="accent">first reading</Badge>
            : p.gate_status
              ? <div className="-mb-2 -ml-6 mt-1 origin-top-right scale-[0.72]"><Stamp status={p.gate_status} runId={p.latest_run_id} /></div>
              : <Badge>no gate</Badge>)}
        </div>

        {p.latest_run_id ? (
          <>
            <div className="flex flex-wrap items-end gap-x-4">
              <div className="shrink-0"><Needle mode="level" value={p.latest_pass_rate} gate={first ? null : gate} size={150} label={`${p.name} pass rate ${pct(p.latest_pass_rate)}`} /></div>
              <div className="flex min-w-0 flex-col gap-1 pb-3">
                <span className="t-label">Pass rate · run <span className="font-mono">#{p.latest_run_id}</span></span>
                <Odometer text={pct(p.latest_pass_rate)} className={clsx('t-fig-xl', good ? 'text-good-ink' : 'text-ink')} />
                {first
                  ? <span className="text-sm text-ink-3">nothing to compare with yet</span>
                  : <span className="text-sm"><PpDelta value={change} /> <span className="text-ink-3">vs <span className="font-mono">#{p.previous_run_id}</span></span></span>}
              </div>
            </div>

            {first ? (
              <div className="flex items-center gap-3 text-sm text-ink-3">
                <svg width={150} height={30} aria-hidden className="shrink-0">
                  <circle cx={5} cy={12} r={3.5} fill="var(--accent)" />
                  <path d="M10,12 C40,12 60,6 145,4" fill="none" stroke="var(--line-strong)" strokeDasharray="3 4" />
                </svg>
                <span>The next run draws the line.</span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-3">
                <Sparkline values={p.trend.map((t) => t.pass_rate)} width={150} height={30} label={`${p.name} pass-rate trend`} />
                <span className="whitespace-nowrap"><span className="font-mono">{p.trend.length}</span> runs{firstRun ? <> · since {dayLabel(firstRun.finished_at ?? firstRun.created_at)}</> : null}</span>
                {p.is_demo && <span className="ml-auto"><Badge title="Seeded sample data (Settings > Defaults can hide it)">Demo</Badge></span>}
              </div>
            )}

            {p.fingerprint && p.fingerprint.length > 0 && <Fingerprint cells={p.fingerprint} size="sm" vt={`fp-run-${p.latest_run_id}`} />}

            {missing.length > 0 && (
              <div className="mt-auto flex items-center gap-2 text-sm text-ink-3">
                <Lightbulb className="size-3.5 shrink-0" />{missing.join(' and ')} {missing.length > 1 ? 'aren’t' : 'isn’t'} reported by this bot. Its connection can map them.
              </div>
            )}
            {first && missing.length === 0 && latest && (
              <div className="mt-auto text-sm text-ink-3">p95 <span className="font-mono">{ms(latest.metrics.p95_latency_ms)}</span> · <span className="font-mono">{usd(latest.metrics.average_cost_usd)}</span> an answer</div>
            )}
            {(p.off_topic_runs ?? 0) > 0 && (
              <div className="text-sm text-ink-3"><span className="mr-1.5 inline-block size-2 rounded-full bg-warn" /><span className="font-mono">{p.off_topic_runs}</span> run{p.off_topic_runs === 1 ? '' : 's'} asked another chatbot’s questions, left out of the trend.</div>
            )}
          </>
        ) : (
          <Empty title="No completed run yet">Start one →</Empty>
        )}
      </Link>
      </Panel>
    </motion.div>
  )
}

export function ConnectCard({ i }: { i: number }) {
  const motionOn = useMotionOn()
  return (
    <motion.div initial={motionOn ? { opacity: 0, y: 10 } : false} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * STAGGER, type: 'spring', stiffness: 260, damping: 26 }}
      className="flex min-w-0 flex-col [&>div]:flex-1">
      <Empty title="Connect another chatbot" action={<Link to="/targets/new" viewTransition className={linkButton('secondary', 'sm')}>Paste a curl command</Link>}>
        Nothing to measure yet. Even a gauge needs something to point at.
      </Empty>
    </motion.div>
  )
}
