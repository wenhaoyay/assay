import { useQuery } from '@tanstack/react-query'
import clsx from 'clsx'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { TraceViewer } from '../components/TraceViewer'
import { Card, Empty, Input, Loading, PageHeader, Select, StatusBadge } from '../components/ui'
import { api } from '../lib/api'
import { ms } from '../lib/format'
import type { RunHeader, TrialDetail, TrialRow } from '../lib/types'

export function TracesPage() {
  const runs = useQuery({ queryKey: ['runs'], queryFn: () => api.get<RunHeader[]>('/api/runs') })
  const [runId, setRunId] = useState<number | null>(null)
  const rid = runId ?? runs.data?.[0]?.id ?? null
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const trials = useQuery({ queryKey: ['trials', rid, {}], queryFn: () => api.get<TrialRow[]>(`/api/runs/${rid}/trials`), enabled: rid !== null })
  const [sel, setSel] = useState<number | null>(null)
  const trial = useQuery({ queryKey: ['trial', sel], queryFn: () => api.get<TrialDetail>(`/api/trials/${sel}`), enabled: sel !== null })
  const rows = (trials.data ?? []).filter((t) => t.status !== 'cancelled' && (!status || t.status === status) && (!search || `${t.case_id} ${t.question}`.toLowerCase().includes(search.toLowerCase())))

  return (
    <>
      <PageHeader title="Traces" description="Observable execution of each trial: the request, retrieval, model and tool calls the target reported, and every evaluator. GaugeLab never needs hidden reasoning." />
      {runs.isLoading ? <Loading /> : !runs.data?.length ? <Empty title="No traces yet">Traces are recorded for every trial of every run.</Empty> : (
        <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
          <Card title="Trials" padded={false}>
            <div className="space-y-2 border-b border-line p-3">
              <Select value={rid ?? ''} onChange={(e) => { setRunId(Number(e.target.value)); setSel(null) }} aria-label="Run">
                {runs.data.map((r) => <option key={r.id} value={r.id}>#{r.id} {r.experiment}</option>)}
              </Select>
              <div className="flex gap-2">
                <Input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search trials" />
                <Select className="w-28" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">All</option><option>passed</option><option>failed</option><option>error</option></Select>
              </div>
            </div>
            <ul className="scroll-thin max-h-[620px] overflow-y-auto">
              {rows.map((t) => (
                <li key={t.id}>
                  <button onClick={() => setSel(t.id)} className={clsx('w-full border-b border-line px-3 py-2 text-left hover:bg-surface-2', sel === t.id && 'bg-surface-2')}>
                    <div className="flex items-center gap-2 text-xs"><StatusBadge status={t.status} /><span className="font-mono">{t.case_id}</span><span className="text-ink-3">#{t.trial_index + 1}</span><span className="num ml-auto text-ink-3">{ms(t.latency_ms)}</span></div>
                    <div className="mt-0.5 truncate text-xs text-ink-2">{t.question}</div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Trace" actions={sel && <Link className="text-xs text-accent-ink hover:underline" to={`/trials/${sel}`}>Open trial detail</Link>}>
            {sel === null ? <p className="text-[13px] text-ink-3">Select a trial.</p> : trial.isLoading ? <Loading /> : trial.data?.trace ? (
              <div className="space-y-3">
                <div className="text-[13px]"><span className="text-ink-3">User: </span>{trial.data.question}</div>
                <TraceViewer spans={trial.data.trace.spans} />
                <div className="text-[13px]"><span className="text-ink-3">Final answer: </span>{trial.data.answer}</div>
              </div>
            ) : <p className="text-[13px] text-ink-3">No trace stored.</p>}
          </Card>
        </div>
      )}
    </>
  )
}
