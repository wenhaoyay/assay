import { useQuery } from '@tanstack/react-query'
import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { RunsTable } from '../components/RunsTable'
import { Card, Code, Empty, ErrorState, Loading, Notice, PageHeader, Stat, StatusBadge } from '../components/ui'
import { api } from '../lib/api'
import { ms, pct } from '../lib/format'
import type { RunHeader } from '../lib/types'

interface Overview {
  counts: Record<string, number>
  recent_runs: RunHeader[]
  latest: RunHeader | null
  active_runs: RunHeader[]
  failed_runs: RunHeader[]
  gate_failures: { run_id: number; experiment: string; failed_gates: string[] }[]
}

export function OverviewPage() {
  const q = useQuery({
    queryKey: ['overview'],
    queryFn: () => api.get<Overview>('/api/overview'),
    refetchInterval: (query) => (query.state.data?.active_runs.length ? 2000 : false),
  })
  if (q.isLoading) return <Loading />
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />
  const o = q.data!
  const l = o.latest

  return (
    <>
      <PageHeader
        title="Overview"
        description="Did the system get better, worse, slower, more expensive or less reliable? Each number comes from a stored run, with its sample size."
        actions={<Link to="/experiments/new" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-[13px] font-medium text-surface hover:bg-ink/85">New experiment <ArrowRight className="size-3.5" /></Link>}
      />

      {o.counts.experiments === 0 ? (
        <Empty title="No runs yet">
          <p>GaugeLab compares versions of a chatbot or agent against a golden dataset. To see it working end to end, load the fictional Acme demo (a support agent in two variants, 58 golden cases, a release gate):</p>
          <p className="mt-2"><Code>gaugelab seed --run</Code> then reload this page.</p>
          <p className="mt-2">Or start with your own system: <Link className="text-accent-ink underline" to="/targets">connect a target</Link>, then <Link className="text-accent-ink underline" to="/datasets">create or import a dataset</Link>.</p>
        </Empty>
      ) : (
        <div className="space-y-5">
          {l && (
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs text-ink-3">
                Latest completed run <Link to={`/runs/${l.id}`} className="font-mono text-accent-ink hover:underline">#{l.id}</Link>
                {l.experiment} - {l.n_cases} cases x {l.trials_per_case} trial(s)
                {l.gate_status && <StatusBadge status={l.gate_status} />}
              </div>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <Stat label="Overall pass rate" value={pct(l.metrics.overall_pass_rate)} sub={`n = ${l.n_cases} cases`} />
                <Stat label="Groundedness (judge)" value={pct(l.metrics.groundedness)} sub={l.judge ? `${l.judge.provider}/${l.judge.model}` : 'no judge configured'} />
                <Stat label="Tool accuracy" value={pct(l.metrics.tool_accuracy)} sub="cases with tool expectations" />
                <Stat label="p95 latency" value={ms(l.metrics.p95_latency_ms)} sub={`p50 ${ms(l.metrics.p50_latency_ms)}`} />
                <Stat label="Failed trials" value={l.failed_trials ?? 'n/a'} sub="see the Failures tab" />
              </div>
            </div>
          )}

          {o.active_runs.length > 0 && (
            <Notice title={`${o.active_runs.length} run(s) in progress`}>
              {o.active_runs.map((r) => (
                <Link key={r.id} to={`/runs/${r.id}`} className="mr-3 underline">#{r.id} {r.experiment} ({r.progress_done}/{r.progress_total})</Link>
              ))}
            </Notice>
          )}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Card title="Recent runs" padded={false} actions={<Link to="/experiments" className="text-xs text-accent-ink hover:underline">All experiments</Link>}>
              <RunsTable runs={o.recent_runs} compact />
            </Card>
            <div className="space-y-5">
              <Card title="Gate failures">
                {o.gate_failures.length === 0 ? (
                  <p className="text-[13px] text-ink-3">No recent run failed a regression gate.</p>
                ) : (
                  <ul className="space-y-2 text-[13px]">
                    {o.gate_failures.map((g) => (
                      <li key={g.run_id}>
                        <Link to={`/runs/${g.run_id}`} className="font-medium hover:underline">#{g.run_id} {g.experiment}</Link>
                        <div className="text-xs text-bad-ink">{g.failed_gates.join(', ')}</div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="Failed runs">
                {o.failed_runs.length === 0 ? (
                  <p className="text-[13px] text-ink-3">None.</p>
                ) : (
                  <ul className="space-y-2 text-[13px]">
                    {o.failed_runs.map((r) => (
                      <li key={r.id}><Link to={`/runs/${r.id}`} className="hover:underline">#{r.id} {r.experiment}</Link><div className="text-xs text-ink-3">{r.error}</div></li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="Workspace">
                <dl className="grid grid-cols-2 gap-y-1 text-[13px]">
                  {Object.entries(o.counts).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="capitalize text-ink-3">{k}</dt>
                      <dd className="num text-right">{v}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
