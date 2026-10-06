import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Button, Card, ErrorState, Field, Input, Json, Loading, Notice, PageHeader, Table } from '../components/ui'
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
      <PageHeader title="Evaluators" description={<>The checks GaugeLab can run. Every score names the check and version that produced it. Grading models are set up in <Link className="text-accent-ink underline" to="/settings?tab=models">Settings - Models &amp; keys</Link>.</>} />
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
    <div className="space-y-5">
      {KINDS.map(([kind, title, desc]) => (
        <Card key={kind} title={title} padded={false}>
          <p className="border-b border-line px-4 py-2 text-xs text-ink-2">{desc}</p>
          <Table>
            <tbody>
              {q.data!.evaluators.filter((e) => e.kind === kind).map((e) => (
                <tr key={e.id} className="align-top">
                  <td className="w-56"><div className="font-medium">{e.name}</div><code className="text-xs text-ink-3">{e.id}</code></td>
                  <td className="text-ink-2">{e.description}
                    {e.rubric && open === e.id && (
                      <div className="mt-2 space-y-2">
                        <dl className="space-y-1 text-xs">{Object.entries(e.rubric.labels).map(([l, d]) => <div key={l}><dt className="inline font-semibold">{l}: </dt><dd className="inline">{d}</dd></div>)}</dl>
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
                    {e.rubric && <div className="font-mono text-[11px] text-ink-3">prompt {e.rubric.prompt_hash}</div>}
                    {e.rubric && <button type="button" className="text-xs text-accent-ink hover:underline" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? 'Hide rubric' : 'Show rubric and prompt'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ))}
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
      <Notice tone="warn" title="Costs are estimates">GaugeLab multiplies reported token counts by this table. A model that is not listed shows cost as <b>unknown</b>, never as zero. Prices change: every row records when it took effect and where it came from.</Notice>
      <Card padded={false}>
        <Table>
          <thead><tr><th>Provider</th><th>Model</th><th className="text-right">Input / 1M</th><th className="text-right">Output / 1M</th><th>From</th><th>Source</th></tr></thead>
          <tbody>{(q.data ?? []).map((p, i) => <tr key={i}><td>{p.provider}</td><td className="font-mono text-xs">{p.model}</td><td className="num text-right">${p.input_per_1m}</td><td className="num text-right">${p.output_per_1m}</td><td className="num text-xs">{p.effective_from}</td><td className="text-xs text-ink-2">{p.source_note}</td></tr>)}</tbody>
        </Table>
      </Card>
      <Card title="Add or override a price">
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
