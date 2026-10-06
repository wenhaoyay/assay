import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import clsx from 'clsx'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { TraceViewer } from '../components/TraceViewer'
import { Badge, Button, Card, ErrorState, Field, Input, Json, Loading, PageHeader, StatusBadge, Table, Tabs } from '../components/ui'
import { api } from '../lib/api'
import { FAILURE_LABELS, ms, num, usd } from '../lib/format'
import type { Score, TrialDetail } from '../lib/types'

const ORDER: Record<string, number> = { fail: 0, error: 1, unknown: 2, pass: 3, not_evaluated: 4, not_applicable: 5 }

export function TrialPage() {
  const { id } = useParams()
  const q = useQuery({ queryKey: ['trial', Number(id)], queryFn: () => api.get<TrialDetail>(`/api/trials/${id}`) })
  const [showNA, setShowNA] = useState(false)
  const [rawTab, setRawTab] = useState<'normalized' | 'raw'>('normalized')
  if (q.isLoading) return <Loading />
  if (q.isError) return <ErrorState error={q.error} />
  const t = q.data!
  const c = t.case
  const r = t.result
  const scores = [...t.scores].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9))
  const visible = scores.filter((s) => showNA || s.status !== 'not_applicable')
  const relevant = new Set((c?.expected.relevant_documents ?? []).flatMap((d) => d.split('|')))
  const cited = new Set((r?.citations ?? []).map((x) => x.id))

  return (
    <>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{t.case_id}</span><span className="font-normal text-ink-2">{c?.title}</span></span>}
        description={<>Run <Link className="underline" to={`/runs/${t.run_id}`}>#{t.run_id}</Link> - trial {t.trial_index + 1} of {t.sibling_trials.length}{c && <> - {c.category}, {c.difficulty}</>}</>}
        actions={
          <>
            <StatusBadge status={t.status} />
            {t.sibling_trials.length > 1 && t.sibling_trials.map((s) => (
              <Link key={s.id} to={`/trials/${s.id}`} className={clsx('rounded px-1.5 py-0.5 text-xs', s.id === t.id ? 'bg-ink text-surface' : 'border border-line hover:bg-surface-2')} title={s.status}>
                #{s.trial_index + 1} {s.status === 'passed' ? 'pass' : s.status === 'failed' ? 'fail' : s.status}
              </Link>
            ))}
          </>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-5">
          <Card title="Question and answer">
            <div className="space-y-3 text-[13px]">
              <div><div className="text-xs text-ink-3">User</div><div className="mt-0.5">{c?.input.message ?? t.question}</div></div>
              <div>
                <div className="text-xs text-ink-3">Answer {r?.provider?.model && <span>({r.provider.provider}/{r.provider.model})</span>}</div>
                <div className={clsx('mt-0.5 whitespace-pre-wrap rounded-md border px-3 py-2', t.status === 'failed' ? 'border-bad/30 bg-bad-wash/40' : 'border-line bg-surface-2/50')}>{t.answer || <span className="text-ink-3">(empty)</span>}</div>
                {r?.error && <div className="mt-1 text-xs text-bad-ink">Target error: {r.error}</div>}
              </div>
              {c && <Expectations c={c} />}
            </div>
          </Card>
          <Card title="Why it passed or failed" actions={<label className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" checked={showNA} onChange={(e) => setShowNA(e.target.checked)} /> show not applicable</label>}>
            <ul className="space-y-2">{visible.map((s) => <ScoreRow key={s.evaluator_id} s={s} />)}</ul>
          </Card>
          <Card title="Execution trace">{t.trace ? <TraceViewer spans={t.trace.spans} /> : <p className="text-[13px] text-ink-3">No trace stored.</p>}</Card>
        </div>
        <div className="space-y-5">
          <Card title="Telemetry">
            <dl className="grid grid-cols-2 gap-y-1 text-[13px]">
              <dt className="text-ink-3">Latency</dt><dd className="num text-right">{ms(t.latency_ms)}</dd>
              <dt className="text-ink-3">Tokens</dt><dd className="num text-right">{num(t.total_tokens)}</dd>
              <dt className="text-ink-3">Target cost (est.)</dt><dd className="num text-right">{usd(t.target_cost_usd)}</dd>
              <dt className="text-ink-3">Judge cost (est.)</dt><dd className="num text-right">{usd(t.judge_cost_usd)}</dd>
              <dt className="text-ink-3">Attempts</dt><dd className="num text-right">{t.attempts}</dd>
            </dl>
          </Card>
          <Card title={`Retrieved documents${r?.retrieved_documents ? ` (${r.retrieved_documents.length})` : ''}`} padded={!r?.retrieved_documents?.length}>
            {r?.retrieved_documents == null ? <p className="text-[13px] text-ink-3">Not reported by the target.</p> : r.retrieved_documents.length === 0 ? <p className="text-[13px] text-ink-3">None.</p> : (
              <Table>
                <thead><tr><th>#</th><th>Document</th><th className="text-right">Score</th><th></th></tr></thead>
                <tbody>
                  {r.retrieved_documents.map((d, i) => (
                    <tr key={`${d.id}-${i}`}>
                      <td className="num text-ink-3">{i + 1}</td>
                      <td className="font-mono text-xs" title={d.text}>{d.id}</td>
                      <td className="num text-right text-xs">{d.score != null ? d.score.toFixed(3) : '-'}</td>
                      <td className="space-x-1">{relevant.has(d.id) && <Badge tone="good">expected</Badge>}{cited.has(d.id) && <Badge tone="info">cited</Badge>}</td>
                    </tr>
                  ))}
                  {[...relevant].filter((d) => !r.retrieved_documents!.some((x) => x.id === d)).map((d) => (
                    <tr key={`missing-${d}`}><td className="text-ink-3">-</td><td className="font-mono text-xs text-bad-ink">{d}</td><td></td><td><Badge tone="bad">expected, not retrieved</Badge></td></tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
          <Card title={`Tool calls${r?.tool_calls ? ` (${r.tool_calls.length})` : ''}`}>
            {r?.tool_calls == null ? <p className="text-[13px] text-ink-3">Not reported by the target.</p> : r.tool_calls.length === 0 ? <p className="text-[13px] text-ink-3">No tools called.</p> : (
              <ol className="space-y-2">
                {r.tool_calls.map((tc, i) => (
                  <li key={i} className="rounded-md border border-line p-2 text-xs">
                    <div className="flex items-center gap-2"><span className="font-mono font-medium">{tc.name}</span><StatusBadge status={tc.status === 'success' ? 'pass' : 'error'} /></div>
                    <div className="mt-1 font-mono text-ink-2">args {JSON.stringify(tc.arguments)}</div>
                    <div className="mt-0.5 font-mono text-ink-3">result {JSON.stringify(tc.result)}</div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
          <FailureAnnotation t={t} />
          <Card title="Response">
            <Tabs tabs={[{ id: 'normalized', label: 'Normalized' }, { id: 'raw', label: 'Raw' }]} value={rawTab} onChange={setRawTab} />
            <div className="mt-2"><Json value={rawTab === 'raw' ? t.raw : r} maxHeight={320} /></div>
          </Card>
        </div>
      </div>
    </>
  )
}

function Expectations({ c }: { c: NonNullable<TrialDetail['case']> }) {
  const e = c.expected
  const rows: [string, string][] = []
  if (e.answer.reference) rows.push(['Reference', e.answer.reference])
  if (e.answer.must_mention.length) rows.push(['Must mention', e.answer.must_mention.join(', ')])
  if (e.answer.must_not_claim.length) rows.push(['Must not claim', e.answer.must_not_claim.join(', ')])
  if (e.relevant_documents.length) rows.push(['Relevant documents', e.relevant_documents.join(', ')])
  if (e.required_tools.length) rows.push(['Required tools', e.required_tools.join(', ')])
  if (e.tool_calls.length) rows.push(['Expected calls', e.tool_calls.map((t) => `${t.name}(${JSON.stringify(t.arguments)})`).join('; ')])
  if (Object.keys(e.expected_outcome).length) rows.push(['Expected outcome', JSON.stringify(e.expected_outcome)])
  if (e.refusal_expected != null) rows.push(['Should decline', e.refusal_expected ? 'yes' : 'no'])
  if (c.description) rows.push(['Note', c.description])
  if (!rows.length) return <p className="text-xs text-ink-3">This case has no expected outcomes (black-box checks only).</p>
  return (
    <div className="rounded-md border border-line">
      <div className="border-b border-line px-3 py-1.5 text-xs font-medium text-ink-2">Expected (written or approved by a person)</div>
      <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2 text-[13px]">
        {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-ink-3">{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </div>
  )
}

function ScoreRow({ s }: { s: Score }) {
  const judge = s.kind === 'llm_judge'
  return (
    <li className={clsx('rounded-md border px-3 py-2', s.status === 'fail' || s.status === 'error' ? 'border-bad/30' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={s.status} />
        <span className="text-[13px] font-medium">{s.evaluator_id}</span>
        <Badge>{s.kind}</Badge>
        {!s.gating && <span className="text-xs text-ink-3">diagnostic</span>}
        {s.failure_type && (s.status === 'fail' || s.status === 'error') && <Badge tone="bad">{FAILURE_LABELS[s.failure_type] ?? s.failure_type}</Badge>}
        {s.score != null && <span className="num ml-auto text-xs text-ink-3">{judge ? 'confidence' : 'score'} {s.score.toFixed(3)}{s.threshold != null && ` / threshold ${s.threshold}`}</span>}
      </div>
      <p className="mt-1 text-[13px] text-ink-2">{s.explanation}</p>
      {s.evidence.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{s.evidence.slice(0, 8).map((e, i) => <code key={i} className="rounded bg-surface-2 px-1 text-xs">{e}</code>)}</div>}
      {judge && s.metadata?.model != null && (
        <div className="mt-1 font-mono text-[11px] text-ink-3">
          {String(s.metadata.provider)}/{String(s.metadata.model)} - rubric v{String(s.metadata.rubric_version)} - prompt {String(s.metadata.prompt_hash)}{s.judge_cost_usd != null && ` - ${usd(s.judge_cost_usd)}`}
        </div>
      )}
      <div className="mt-0.5 font-mono text-[11px] text-ink-3">v{s.evaluator_version}</div>
    </li>
  )
}

function FailureAnnotation({ t }: { t: TrialDetail }) {
  const qc = useQueryClient()
  const types = useQuery({ queryKey: ['failure-types'], queryFn: () => api.get<string[]>('/api/failure-types') })
  const [sel, setSel] = useState<string[]>(t.failure_types)
  const [note, setNote] = useState(t.failure_note)
  const save = useMutation({
    mutationFn: (clear: boolean) => api.put(`/api/trials/${t.id}/failure`, { failure_types: clear ? null : sel, note }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['trial', t.id] }); qc.invalidateQueries({ queryKey: ['run', String(t.run_id)] }) },
  })
  return (
    <Card title="Failure classification" actions={t.failure_override ? <Badge tone="info">manual</Badge> : <Badge>automatic</Badge>}>
      <div className="flex flex-wrap gap-1">
        {(types.data ?? []).map((ft) => (
          <button key={ft} onClick={() => setSel((s) => (s.includes(ft) ? s.filter((x) => x !== ft) : [...s, ft]))}
            className={clsx('rounded px-1.5 py-0.5 text-[11px]', sel.includes(ft) ? 'bg-ink text-surface' : 'border border-line text-ink-2 hover:bg-surface-2')}>
            {FAILURE_LABELS[ft] ?? ft}
          </button>
        ))}
      </div>
      <div className="mt-2"><Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you reclassified it" /></Field></div>
      {save.isError && <div className="mt-2"><ErrorState error={save.error} /></div>}
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(false)}>Save classification</Button>
        {t.failure_override && <Button size="sm" variant="ghost" onClick={() => save.mutate(true)}>Revert to automatic</Button>}
      </div>
    </Card>
  )
}
