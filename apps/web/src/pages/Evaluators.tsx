import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, Empty, ErrorState, Field, Input, Json, Loading, Notice, PageHeader, Table } from '../components/ui'
import { api } from '../lib/api'
import { useCrumbs } from '../lib/crumbs'
import type { EvaluatorInfo } from '../lib/types'

const KINDS: [EvaluatorInfo['kind'], string, string][] = [
  ['deterministic', 'Deterministic', 'Decided by code. Preferred whenever the answer can be checked objectively.'],
  ['retrieval', 'Retrieval', 'IR metrics over labelled relevant documents. Retrieval quality is not answer quality.'],
  ['agent', 'Agent / tool use', 'Required behaviour and outcomes, not one fixed trajectory.'],
  ['performance', 'Performance and cost', 'Latency and token/cost budgets per trial.'],
  ['llm_judge', 'Meaning (grading model)', 'Only where meaning must be judged. Versioned PASS/FAIL/UNKNOWN rubrics, strict JSON output, untrusted-content fencing.'],
]

export function EvaluatorsPage() {
  useCrumbs([{ label: 'Judge trust' }, { label: 'Evaluators' }], 'evaluators')
  return (
    <>
      <PageHeader title="Evaluators" help={<>
        <p>The checks GaugeLab can run, grouped by how they decide. Every score names the check and version that produced it.</p>
        <p>Gating checks count toward the pass rate; diagnostic ones are shown but never fail a run. Checks that use a grading model show their rubric and prompt.</p>
        <p>Grading models are set up in <Link className="text-accent-ink underline" to="/settings?tab=models">Settings · Models &amp; keys</Link>.</p>
      </>} />
      <EvaluatorList />
    </>
  )
}

function EvaluatorList() {
  const q = useQuery({ queryKey: ['evaluators'], queryFn: () => api.get<{ evaluators: EvaluatorInfo[] }>('/api/evaluators') })
  const [open, setOpen] = useState<string | null>(null)
  if (q.isLoading) return <Loading />
  if (q.isError) return <ErrorState error={q.error} />
  return (
    <div className="space-y-10">
      {KINDS.map(([kind, title, desc]) => {
        const list = q.data!.evaluators.filter((e) => e.kind === kind)
        return (
        <Card key={kind} title={title} help={<p>{desc}</p>} meta={`${list.length}`} padded={false}>
          {list.length === 0 ? <div className="py-4"><Empty title="None of this kind yet." /></div> : (
          <Table>
            <tbody>
              {list.map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="w-56"><div className="font-medium text-ink">{e.name}</div><code className="font-mono text-xs text-ink-3">{e.id}</code></td>
                  <td className="text-ink-2">{e.description}
                    {e.rubric && open === e.id && (
                      <div className="mt-2 space-y-2">
                        <dl className="space-y-1 text-xs">{Object.entries(e.rubric.labels).map(([l, d]) => <div key={l}><dt className="inline font-mono font-semibold text-ink">{l}: </dt><dd className="inline">{d}</dd></div>)}</dl>
                        {e.rubric.notes && <p className="text-xs italic">{e.rubric.notes}</p>}
                        <Json value={e.rubric.system_prompt} maxHeight={240} />
                      </div>
                    )}
                  </td>
                  <td className="w-60 space-y-1 text-right">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Badge className="font-mono">v{e.version}</Badge>
                      {e.gating ? <Badge>gating</Badge> : <Badge tone="info">diagnostic</Badge>}
                      {e.calibration && <Badge tone={e.calibration.n ? 'good' : 'warn'}>{e.calibration.status}</Badge>}
                    </div>
                    {e.rubric && <div className="font-mono text-label text-ink-3">prompt {e.rubric.prompt_hash}</div>}
                    {e.rubric && <button type="button" className="text-xs text-accent-ink hover:underline" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'Hide rubric' : 'Show rubric and prompt'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          )}
        </Card>
        )
      })}
    </div>
  )
}

export function Pricing() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['pricing'], queryFn: () => api.get<{ provider: string; model: string; input_per_1m: number; output_per_1m: number; effective_from: string; source_note: string }[]>('/api/pricing') })
  const [f, setF] = useState(() => ({ provider: '', model: '', input_per_1m: '', output_per_1m: '', effective_from: new Date().toISOString().slice(0, 10), source_note: '' }))
  const add = useMutation({ mutationFn: () => api.post('/api/pricing', { ...f, input_per_1m: Number(f.input_per_1m), output_per_1m: Number(f.output_per_1m) }), onSuccess: () => qc.invalidateQueries({ queryKey: ['pricing'] }) })
  return (
    <div className="space-y-4">
      <Notice tone="warn" title="Costs are estimates">GaugeLab multiplies reported token counts by this table. A model that is not listed shows cost as <span className="font-semibold">unknown</span>, never as zero. Prices change: every row records when it took effect and where it came from.</Notice>
      <Card title="Prices" meta={`${(q.data ?? []).length}`} padded={false}>
        <Table>
          <thead><tr className="whitespace-nowrap"><th className="t-label">Provider</th><th className="t-label">Model</th><th className="t-label text-right">Input / 1M</th><th className="t-label text-right">Output / 1M</th><th className="t-label">From</th><th className="t-label">Source</th></tr></thead>
          <tbody>{(q.data ?? []).map((p, i) => <tr key={i}><td>{p.provider}</td><td className="font-mono text-xs">{p.model}</td><td className="num text-right font-mono">${p.input_per_1m}</td><td className="num text-right font-mono">${p.output_per_1m}</td><td className="num font-mono text-xs">{p.effective_from}</td><td className="text-xs text-ink-2">{p.source_note}</td></tr>)}</tbody>
        </Table>
      </Card>
      <Card title="Add or override a price" boxed help={<p>A new row for a provider and model takes effect from its date; older runs keep the price that applied then. Say where the price came from.</p>}>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
          {(['provider', 'model', 'input_per_1m', 'output_per_1m', 'effective_from', 'source_note'] as const).map((k) => (
            <Field key={k} label={k.replace(/_/g, ' ')}><Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>
          ))}
        </div>
        {add.isError && <div className="mt-2"><ErrorState error={add.error} /></div>}
        <Button className="mt-3" variant="primary" disabled={!f.provider || !f.model || !f.source_note} loading={add.isPending} onClick={() => add.mutate()}>Save price</Button>
      </Card>
    </div>
  )
}
